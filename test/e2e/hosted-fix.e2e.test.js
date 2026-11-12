// End to end, fixes from a hosted board: a real hosted server, an agent
// connected from a throwaway git repository whose machine takes edits with
// an admin's approval (the link in this process, with the scripted agent of
// test/fixtures/acp-remote-fix.mjs that edits with its own file calls), and
// signed-in people in real browsers with a passkey.
//
// "Fix with Builder" on a comment opens the comment's chat; the request to
// edit shows as a card with its diff; an admin allows it (the passkey step
// included) and a second admin sees it change without reloading; a member
// reads who is waited for and has no buttons; the fix ends as a branch with
// its name to copy, the comment says so, and the checkout is untouched.
// Deny leaves "Denied by ..." and no branch. An agent that only reads
// offers no Fix button and says why. The strip above the board lists a
// waiting card and opens its chat. The console says which mode the agent is
// in and why "Allow without asking" cannot be chosen. With two agents that
// can fix, the button's caret chooses one; a machine that takes answers
// from its connector only says so to everyone else; and once its machine and
// the rule both allow it, an edit goes without asking and the card says so.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots (light, dark and a phone).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { createProject, invite, reauth, signUp, startHostedServer, writeLocalCaptures } from '../hosted-helpers.js'
import { connectAgent, fixScript, gitRepo, startLink } from '../hosted-chat-helpers.js'
import { sampleConfig, tempDir } from '../helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null

let hosted
let browser
let ada // the owner, who connects the agents
let bea // an admin
let cyd // a member
let ws
let project
let builder // edits with an admin's approval
let repoDir
let git
const contexts = []
const links = []

const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const boardUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const boardPage = (query = '') => `${hosted.origin}/w/${ws}/p/${project.id}/?board=sample${query}`
const fresh = async (user) => {
  hosted.rateLimiter.reset()
  await reauth(user)
}
// Every session's passkey check is old: the next Allow has to ask for it.
const stale = () => hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date(Date.now() - 60 * 60 * 1000).toISOString())

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// A browser signed in as `user`, with the user's passkey in a virtual
// authenticator (the one the test signed up with), so a passkey prompt is
// answered like a person's touch.
async function open(user, { width = 1440, height = 900, dark = false, phone = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: dark ? 'dark' : 'light',
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  })
  contexts.push(context)
  await context.addCookies([...user.browser.jar].map(([name, value]) => ({ name, value, url: hosted.origin })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
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
  const standard = (text) => Buffer.from(text, 'base64url').toString('base64')
  for (const [id, credential] of user.authenticator.credentials) {
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: standard(id),
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: credential.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        userHandle: standard(credential.userHandle),
        signCount: 0,
      },
    })
  }
  return { context, page, errors, phone }
}
// The 403s are the server asking for the passkey (answered right after).
const realErrors = (errors) => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

// The same person at 1440 light and, when screenshots are kept, 1440 dark
// and a phone: every state is then shot three times.
async function views(user) {
  const light = await open(user)
  if (!SHOTS) return [light]
  return [light, await open(user, { dark: true }), await open(user, { width: 390, height: 844, phone: true })]
}
const SUFFIX = ['1440-light', '1440-dark', '390-light']
async function shots(list, name) {
  if (!SHOTS) return
  for (const [index, view] of list.entries()) {
    await view.page.screenshot({ path: path.join(SHOTS, `${name}-${SUFFIX[index]}.png`), fullPage: false, animations: 'disabled' })
  }
}
const each = (list, run) => Promise.all(list.map((view) => run(view.page, view)))
const press = (view, selector) => (view.phone ? view.page.tap(selector) : view.page.click(selector))

async function pushSample() {
  await fresh(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  assert.equal(made.status, 201, made.text)
  const config = sampleConfig('hosted-fix-e2e-site')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const begun = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(begun.id, area, name, fs.readFileSync(file))
  await remote.commitPush(begun.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
}
async function comment(user, body) {
  hosted.rateLimiter.reset()
  const made = await user.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 30, y: 30, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
const seen = async (id) => (await ada.browser.get(boardUrl('/comments'))).json.comments.find((item) => item.id === id)
const branches = () => git('branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
const chatOf = (id) => `&chat=c${id}`
const card = (page, state) => page.locator(`[data-sw-chat-card="permission"][data-state="${state}"]`).last()

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the hosted fix e2e test')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the hosted fix e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  hosted = await startHostedServer('hosted-fix-e2e', { clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  bea = await signUp(hosted, { handle: 'bea', displayName: 'Bea', invite: await invite(ada, ws, 'admin') })
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  await pushSample()
  await fresh(ada)
  // Members may use an agent here (its audience still decides which).
  const policy = await ada.browser.call('PUT', consoleUrl('/agent'), {
    body: { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false, dailyClaims: 500, maxOpenClaims: 50 },
  })
  assert.equal(policy.status, 200, policy.text)
  browser = await chromium.launch()
})

after(async () => {
  for (const entry of links) await entry.stop()
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  await hosted?.close()
})

test('an agent that reads and answers only: no Fix button on a comment, and one line that says why', async () => {
  const scout = await connectAgent(hosted, ada, {
    workspaceId: ws,
    projectId: project.id,
    name: 'Scout',
    kind: 'codex',
    audience: 'trusted',
  })
  assert.equal(scout.status, 200, JSON.stringify(scout.error))
  const link = startLink(hosted, scout.token, { kind: 'codex' })
  links.push(link)
  assert.ok(await link.ready)
  const first = await comment(ada, 'The heading should greet people.')
  const list = await views(ada)
  await each(list, async (page, view) => {
    await page.goto(boardPage(`&c=${first.id}`))
    await page.waitForSelector(`[data-sw-thread${view.phone ? '-sheet' : '-popover'}="${first.id}"] [data-sw-hosted-fix-reason]`)
  })
  const { page, errors } = list[0]
  assert.match(
    await page.textContent('[data-sw-hosted-fix-reason]'),
    /Scout reads and answers only\. Edits are switched on on its own machine/,
  )
  assert.equal(await page.locator('[data-sw-hosted-fix]').count(), 0, 'no Fix button')
  assert.equal(await page.locator(`[data-sw-send-agent-block="${first.id}"]`).count(), 1, 'Send to agent stays')
  await shots(list, 'thread-no-fix')
  // The Agents panel says the same about it, in its own line.
  await page.goto(boardPage('&ha=1'))
  const row = page.locator('[data-sw-hosted-agent-name="Scout"]')
  await row.waitFor()
  assert.equal(await row.locator('[data-sw-hosted-agent-mode]').getAttribute('data-sw-hosted-agent-mode'), 'none')
  assert.match(await row.textContent(), /Reads and answers\. No edits, no commands\./)
  assert.deepEqual(realErrors(errors), [])
})

test('Fix with Builder: the card with its diff, Allow with the passkey, the branch to copy, and the comment says it is ready', async () => {
  // The machine that has the code opted in: edits from the board, each allowed by an admin.
  repoDir = tempDir('hosted-fix-e2e-repo')
  git = gitRepo(repoDir)
  builder = await connectAgent(hosted, ada, {
    workspaceId: ws,
    projectId: project.id,
    name: 'Builder',
    kind: 'claude',
    audience: 'trusted',
  })
  assert.equal(builder.status, 200, JSON.stringify(builder.error))
  const link = startLink(hosted, builder.token, { cwd: repoDir, edits: { approvals: 'admins' } })
  links.push(link)
  assert.ok(await link.ready, link.failure()?.message)
  const made = await comment(ada, `Say "Hi there" in the heading. ${fixScript([['edit', 'index.html', 'Hello', 'Hi there']])}`)
  const id = made.id

  // Ada on the comment; Bea (an admin) with no panel open; Cyd (a member) in the comment's chat.
  const adas = await views(ada)
  const beas = await views(bea)
  const cyds = await views(cyd)
  const one = adas[0]
  await each(adas, async (page, view) => {
    await page.goto(boardPage(`&c=${id}`))
    await page.waitForSelector(`[data-sw-thread${view.phone ? '-sheet' : '-popover'}="${id}"] [data-sw-hosted-fix="${id}"]`)
  })
  assert.equal(await one.page.getAttribute(`[data-sw-hosted-fix="${id}"]`, 'data-sw-hosted-fix-agent'), 'Builder')
  assert.match(await one.page.textContent(`[data-sw-hosted-fix="${id}"]`), /Fix with Builder/)
  assert.match(await one.page.textContent('[data-sw-hosted-fix-mode="ask"]'), /Edits on a branch, each allowed by an admin/)
  assert.equal(await one.page.locator('[data-sw-hosted-fix-choose]').count(), 0, 'one agent can fix: no picker')
  await shots(adas, 'thread-fix-button')
  await each(beas, (page) => page.goto(boardPage()))
  await each(cyds, (page) => page.goto(boardPage(chatOf(id))))

  // Fix: the comment's chat opens and the request to edit shows, with its diff.
  stale()
  await press(one, `[data-sw-hosted-fix="${id}"]`)
  await card(one.page, 'pending').waitFor({ timeout: 30_000 })
  const asked = card(one.page, 'pending')
  assert.equal(await asked.locator('[data-sw-chat-permission-path]').textContent(), 'index.html')
  const diff = await asked.locator('[data-sw-chat-diff]').textContent()
  assert.match(diff, /Hello/)
  assert.match(diff, /Hi there/)
  assert.equal(await asked.locator('[data-sw-chat-permission-option="allow"]').count(), 1)
  assert.equal(await asked.locator('[data-sw-chat-permission-option="deny"]').count(), 1)
  assert.equal(await asked.locator('[data-sw-chat-permission-allow-chat]').count(), 0, 'no "Allow for this chat" on a hosted board')
  assert.match(await one.page.textContent('[data-sw-chat-message="user"]'), new RegExp(`Fix comment #${id} with Builder`))
  // The other views of Ada join the same turn.
  await each(adas.slice(1), async (page) => {
    await page.goto(boardPage(chatOf(id)))
    await card(page, 'pending').waitFor({ timeout: 30_000 })
  })
  await shots(adas, 'chat-card-waiting')
  if (adas[2]) {
    const allow = await adas[2].page.locator('[data-sw-chat-permission-option="allow"]').boundingBox()
    const deny = await adas[2].page.locator('[data-sw-chat-permission-option="deny"]').boundingBox()
    assert.ok(allow.height >= 44 && deny.height >= 44, 'phone-sized answers')
    const box = await card(adas[2].page, 'pending').boundingBox()
    assert.ok(allow.width + deny.width > box.width * 0.85, 'the two answers fill the row on a phone')
    assert.equal(Math.round(allow.y), Math.round(deny.y), 'side by side')
  }
  // The comment is with the agent.
  await until(async () => (await seen(id)).agentStatus === 'working', 'the comment to be with the agent')

  // A member reads who is waited for, and has no buttons.
  await each(cyds, (page) => card(page, 'pending').waitFor({ timeout: 30_000 }))
  const members = card(cyds[0].page, 'pending')
  assert.match(
    await members.locator('[data-sw-chat-permission-waiting]').textContent(),
    /Waiting for an admin Builder takes work from to allow or deny this\./,
  )
  assert.equal(await members.locator('[data-sw-chat-permission-option]').count(), 0)
  assert.match(await members.locator('[data-sw-chat-diff]').textContent(), /Hi there/, 'the member reads the same diff')
  await shots(cyds, 'chat-card-member')

  // The strip above the board lists it for the other admin, panel closed; it opens the chat.
  await each(beas, (page) => page.waitForSelector(`[data-sw-hosted-card-thread="comment-${id}"]`, { timeout: 30_000 }))
  const two = beas[0]
  assert.match(await two.page.textContent('[data-sw-hosted-card]'), new RegExp(`Builder asks before it acts, on comment #${id}`))
  assert.match(await two.page.textContent('[data-sw-hosted-card]'), /Edit a file:\s*index\.html/)
  await shots(beas, 'strip-card')
  await each(beas, async (page, view) => {
    await press(view, `[data-sw-hosted-card-open="comment-${id}"]`)
    await card(page, 'pending').waitFor({ timeout: 30_000 })
  })
  assert.equal(await card(two.page, 'pending').locator('[data-sw-chat-permission-option="allow"]').count(), 1, 'an admin may answer')

  // Allow: the server asks for the passkey, the browser gives it, and the answer goes.
  const reauths = []
  one.page.on('response', (response) => {
    if (/\/auth\/reauth\/verify$/.test(response.url())) reauths.push(response.status())
  })
  await press(one, '[data-sw-chat-card="permission"][data-state="pending"] [data-sw-chat-permission-option="allow"]')
  await card(one.page, 'approved').waitFor({ timeout: 30_000 })
  assert.deepEqual(reauths, [200], 'the passkey was checked once')
  // Bea did not reload: her card went from waiting to allowed, by name.
  await each([...beas, ...cyds, ...adas], (page) => card(page, 'approved').waitFor({ timeout: 30_000 }))
  assert.equal(await card(two.page, 'approved').locator('[data-sw-chat-permission-state]').textContent(), 'Allowed by Ada')
  assert.equal(await card(two.page, 'approved').locator('[data-sw-chat-permission-option]').count(), 0)
  assert.equal(await card(cyds[0].page, 'approved').locator('[data-sw-chat-permission-state]').textContent(), 'Allowed by Ada')

  // The result: the branch, its name to copy, not pushed, the file with its counts. Nothing to apply or undo.
  await each([...adas, ...beas], (page) => page.waitForSelector('[data-sw-chat-summary="remote-branch"]', { timeout: 60_000 }))
  const summary = one.page.locator('[data-sw-chat-summary="remote-branch"]')
  const name = await summary.locator('[data-sw-chat-branch-name]').getAttribute('data-sw-chat-branch-name')
  assert.match(
    await summary.locator('[data-sw-chat-remote-branch]').textContent(),
    new RegExp(`Fix ready on branch\\s*${name.replace(/[/.]/g, '\\$&')}`),
  )
  assert.match(await summary.locator('[data-sw-chat-branch-pushed="false"]').textContent(), /On the agent's machine, not pushed/)
  assert.match(await summary.locator('[data-sw-chat-summary-file="index.html"]').textContent(), /\+1\s*-1/)
  for (const gone of [
    '[data-sw-chat-branch-apply]',
    '[data-sw-chat-branch-discard]',
    '[data-sw-chat-undo]',
    '[data-sw-chat-summary-recapture]',
  ])
    assert.equal(await summary.locator(gone).count(), 0, `${gone} is not on a hosted board`)
  await press(one, '[data-sw-chat-branch-copy]')
  await one.page.waitForSelector('[data-sw-chat-branch-note]')
  assert.equal(await one.page.evaluate(() => navigator.clipboard.readText()), name)
  await one.page.waitForSelector('[data-sw-chat-send]', { timeout: 30_000 })
  await shots(adas, 'chat-fix-ready')

  // On the machine: a commit on that branch, and the checkout untouched.
  assert.equal(git('status', '--porcelain'), '', 'the checkout is clean')
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(fs.readFileSync(path.join(repoDir, 'index.html'), 'utf8'), '<h1>Hello</h1>\n')
  assert.ok(branches().includes(name), `the branch ${name} exists: ${branches()}`)
  assert.match(git('show', `${name}:index.html`), /Hi there/)

  // The comment: the agent's reply, and a fix waiting on a branch (nothing to apply here).
  await until(
    async () => ((item) => item.agentStatus === 'branch-ready' && item.replies.length > 0)(await seen(id)),
    'the comment to say the fix is ready',
  )
  await each(adas, async (page, view) => {
    await page.goto(boardPage(`&c=${id}`))
    const thread = `[data-sw-thread${view.phone ? '-sheet' : '-popover'}="${id}"]`
    await page.waitForSelector(`${thread} [data-sw-agent-status="branch-ready"]`)
    await page.waitForSelector(`${thread} [data-sw-reply]`)
    await page.waitForSelector(`${thread} [data-sw-hosted-fix-view="branch"]`)
  })
  const thread = one.page.locator(`[data-sw-thread-popover="${id}"]`)
  assert.match(await thread.locator('[data-sw-agent-status="branch-ready"]').textContent(), /Fix ready on branch/)
  assert.doesNotMatch(await thread.textContent(), /apply/i)
  assert.equal(await thread.locator(`[data-sw-hosted-fix="${id}"]`).count(), 0, 'no second fix while one waits on its branch')
  await shots(adas, 'thread-fix-ready')
  // "View the fix" opens the chat again.
  await press(one, '[data-sw-hosted-fix-view="branch"]')
  await one.page.waitForSelector('[data-sw-chat-summary="remote-branch"]')
  for (const view of [...adas, ...beas, ...cyds]) assert.deepEqual(realErrors(view.errors), [])
})

test('Deny: the card says who denied it, nothing is edited and there is no branch', async () => {
  const before = branches()
  const made = await comment(ada, `Make the heading green. ${fixScript([['edit', 'styles.css', 'blue', 'green']])}`)
  const id = made.id
  const adas = await views(ada)
  const one = adas[0]
  const watcher = await open(bea)
  await each(adas, (page) => page.goto(boardPage(`&c=${id}`)))
  await one.page.waitForSelector(`[data-sw-hosted-fix="${id}"]`)
  await watcher.page.goto(boardPage(chatOf(id)))
  await press(one, `[data-sw-hosted-fix="${id}"]`)
  await card(one.page, 'pending').waitFor({ timeout: 30_000 })
  await card(watcher.page, 'pending').waitFor({ timeout: 30_000 })
  await each(adas.slice(1), async (page) => {
    await page.goto(boardPage(chatOf(id)))
    await card(page, 'pending').waitFor({ timeout: 30_000 })
  })
  // Bea denies; Ada, who asked, sees it without reloading.
  await watcher.page.click('[data-sw-chat-card="permission"][data-state="pending"] [data-sw-chat-permission-option="deny"]')
  await each(adas, (page) => card(page, 'denied').waitFor({ timeout: 30_000 }))
  assert.equal(await card(one.page, 'denied').locator('[data-sw-chat-permission-state]').textContent(), 'Denied by Bea')
  await one.page.waitForSelector('[data-sw-chat-send]', { timeout: 60_000 })
  await each(adas.slice(1), (page) => page.waitForSelector('[data-sw-chat-send]', { timeout: 60_000 }))
  assert.equal(await one.page.locator('[data-sw-chat-summary]').count(), 0, 'no branch block')
  assert.equal(await one.page.locator('[data-sw-chat-remote-branch]').count(), 0)
  await shots(adas, 'chat-card-denied')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(fs.readFileSync(path.join(repoDir, 'styles.css'), 'utf8'), 'h1 { color: blue; }\n')
  assert.deepEqual(branches(), before, 'no branch was left for a fix that changed nothing')
  await until(async () => (await seen(id)).agentStatus !== 'working', 'the comment to leave the agent')
  assert.deepEqual(realErrors(one.errors), [])
  assert.deepEqual(realErrors(watcher.errors), [])
})

test('two agents that can fix: the picker chooses one; "only the person who connected it" answers; then allowed without asking', async () => {
  // Bea connects Fixer from another repository. Its machine lets only her answer, and lets edits go without asking.
  const dir = tempDir('hosted-fix-e2e-repo-2')
  const fixerGit = gitRepo(dir)
  const fixer = await connectAgent(hosted, bea, {
    workspaceId: ws,
    projectId: project.id,
    name: 'Fixer',
    kind: 'codex',
    audience: 'trusted',
  })
  assert.equal(fixer.status, 200, JSON.stringify(fixer.error))
  const link = startLink(hosted, fixer.token, { cwd: dir, kind: 'codex', edits: { approvals: 'owner', auto: ['edits'] } })
  links.push(link)
  assert.ok(await link.ready, link.failure()?.message)
  const made = await comment(ada, `Greet by name. ${fixScript([['edit', 'index.html', 'Hello', 'Hello, Ada']])}`)
  const id = made.id

  // The button names one agent; its caret lists both, each with how its edits are allowed.
  const adas = await views(ada)
  const one = adas[0]
  await each(adas, async (page, view) => {
    await page.goto(boardPage(`&c=${id}`))
    await page.waitForSelector(`[data-sw-hosted-fix-split="${id}"]`)
    await press(view, `[data-sw-hosted-fix-choose="${id}"]`)
    await page.waitForSelector(`[data-sw-hosted-fix-menu="${id}"] [data-sw-agent-option="${fixer.agentId}"]`)
  })
  const menu = one.page.locator(`[data-sw-hosted-fix-menu="${id}"]`)
  assert.equal(await menu.locator('[data-sw-agent-option]').count(), 2, 'Scout only reads: it is not offered')
  assert.match(
    await menu.locator(`[data-sw-agent-option="${builder.agentId}"]`).textContent(),
    /Builder.*Edits on a branch, each allowed by an admin/,
  )
  assert.match(
    await menu.locator(`[data-sw-agent-option="${fixer.agentId}"]`).textContent(),
    /Fixer.*Edits on a branch, each allowed by the person who connected it/,
  )
  await shots(adas, 'thread-fix-picker')
  await each(adas.slice(1), (page) => page.keyboard.press('Escape'))
  await press(one, `[data-sw-hosted-fix-menu="${id}"] [data-sw-agent-option="${fixer.agentId}"]`)
  await card(one.page, 'pending').waitFor({ timeout: 30_000 })
  assert.match(await one.page.textContent('[data-sw-chat-message="user"]'), new RegExp(`Fix comment #${id} with Fixer`))
  // Ada owns the workspace, and still does not answer: Fixer's machine takes answers from Bea only.
  const asked = card(one.page, 'pending')
  assert.match(await asked.locator('[data-sw-chat-permission-waiting]').textContent(), /Waiting for Bea to allow or deny this\./)
  assert.equal(await asked.locator('[data-sw-chat-permission-option]').count(), 0)
  assert.equal(await one.page.textContent('[data-sw-chat-activity-label]'), 'Waiting for an answer')
  await each(adas.slice(1), async (page) => {
    await page.goto(boardPage(chatOf(id)))
    await card(page, 'pending').waitFor({ timeout: 30_000 })
  })
  await shots(adas, 'chat-card-owner-only')
  // Bea allows it from her own board (her passkey is asked for).
  stale()
  const hers = await open(bea)
  await hers.page.goto(boardPage(chatOf(id)))
  await hers.page.click('[data-sw-chat-card="permission"][data-state="pending"] [data-sw-chat-permission-option="allow"]')
  await card(one.page, 'approved').waitFor({ timeout: 30_000 })
  assert.equal(await card(one.page, 'approved').locator('[data-sw-chat-permission-state]').textContent(), 'Allowed by Bea')
  await one.page.waitForSelector('[data-sw-chat-summary="remote-branch"]', { timeout: 60_000 })
  assert.equal(fixerGit('status', '--porcelain'), '')

  // The console: this machine said edits may go without asking, so the rule can be chosen.
  hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date().toISOString())
  const consoles = await views(bea)
  const desk = consoles[0]
  await each(consoles, async (page, view) => {
    await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
    await page.waitForSelector('[data-sw-agent-row="Fixer"] [data-sw-agent-mode="ask"]')
    await press(view, '[data-sw-agent-approval-edit="Fixer"]')
    await page.waitForSelector('[data-sw-agent-approval-dialog]')
  })
  const dialog = desk.page.locator('[data-sw-agent-approval-dialog]')
  assert.match(await dialog.locator('[data-sw-agent-machine-fact="approvals"]').textContent(), /Only Bea may answer\./)
  assert.match(await dialog.locator('[data-sw-agent-machine-fact="auto"]').textContent(), /Edits, when the rule below says so\./)
  const auto = dialog.locator('[data-sw-agent-approval-option="auto"]')
  assert.equal(await auto.getAttribute('aria-disabled'), null, 'it can be chosen')
  assert.equal(await dialog.locator('[data-sw-agent-approval-unavailable]').count(), 0)
  assert.match(await auto.locator('[data-sw-agent-approval-applies]').textContent(), /Applies to edits, as its machine allows/)
  await each(consoles, (page, view) => press(view, '[data-sw-agent-approval-option="auto"]'))
  assert.equal(await auto.getAttribute('aria-checked'), 'true')
  await shots(consoles, 'console-approvals-auto')
  await desk.page.click('[data-sw-agent-approval-save]')
  await desk.page.waitForSelector('[data-sw-agent-row="Fixer"] [data-sw-agent-mode="auto"]')
  assert.match(
    await desk.page.textContent('[data-sw-agent-row="Fixer"] [data-sw-agent-mode]'),
    /Edits on a branch, allowed without asking\. Applies to edits\./,
  )

  // A fix with Fixer now: the edit is allowed on its machine, and the card says so.
  const next = await comment(ada, `Greet twice. ${fixScript([['edit', 'styles.css', 'blue', 'teal']])}`)
  await each(adas, async (page, view) => {
    await page.goto(boardPage(`&c=${next.id}`))
    await page.waitForSelector(`[data-sw-hosted-fix-split="${next.id}"]`)
    if (view !== one) return
    await press(view, `[data-sw-hosted-fix-choose="${next.id}"]`)
    await press(view, `[data-sw-hosted-fix-menu="${next.id}"] [data-sw-agent-option="${fixer.agentId}"]`)
  })
  await one.page.waitForSelector('[data-sw-chat-summary="remote-branch"]', { timeout: 60_000 })
  const allowed = card(one.page, 'approved')
  assert.equal(await allowed.locator('[data-sw-chat-permission-state]').textContent(), 'Allowed automatically')
  assert.match(await allowed.locator('[data-sw-chat-diff]').textContent(), /teal/, 'the diff is still shown')
  await each(adas.slice(1), async (page) => {
    await page.goto(boardPage(chatOf(next.id)))
    await page.waitForSelector('[data-sw-chat-summary="remote-branch"]')
  })
  await shots(adas, 'chat-card-auto')
  assert.equal(fixerGit('status', '--porcelain'), '')
  assert.equal(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), 'h1 { color: blue; }\n')
  for (const view of [...adas, ...consoles, hers]) assert.deepEqual(realErrors(view.errors), [])
})

test('the Agents panel and the console say which mode each agent is in, and why "Allow without asking" is not offered', async () => {
  const list = await views(ada)
  const { page, errors } = list[0]
  await each(list, async (view, entry) => {
    await view.goto(boardPage())
    if (entry.phone) {
      await view.waitForSelector('[data-sw-menu]')
      await view.tap('[data-sw-menu]')
      await view.tap('[data-sw-hosted-agent-open]')
    } else {
      await view.waitForSelector('[data-sw-chat-toggle]')
      await view.click('[data-sw-chat-toggle]')
    }
    await view.locator('[data-sw-hosted-agent-name="Builder"] [data-sw-hosted-agent-mode="ask"]').waitFor()
  })
  assert.match(await page.textContent('[data-sw-hosted-agent-name="Builder"]'), /Edits on a branch, each allowed by an admin/)
  assert.match(await page.textContent('[data-sw-hosted-agent-name="Scout"]'), /Reads and answers\. No edits, no commands\./)
  await shots(list, 'board-agents-modes')

  await each(list, async (view) => {
    await view.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
    await view.waitForSelector('[data-sw-agent-row="Builder"] [data-sw-agent-mode="ask"]')
  })
  const row = page.locator('[data-sw-agent-row="Builder"]')
  assert.match(await row.textContent(), /makes fixes on a branch, each edit allowed by a person/)
  assert.match(await row.locator('[data-sw-agent-mode]').textContent(), /Edits on a branch, asking every time\. Admins and up answer/)
  assert.match(
    await page.locator('[data-sw-agent-row="Scout"] [data-sw-agent-mode="none"]').textContent(),
    /Reads and answers\. Nothing to approve/,
  )
  await shots(list, 'console-agents-modes')
  await each(list, async (view, entry) => {
    await press(entry, '[data-sw-agent-approval-edit="Builder"]')
    await view.waitForSelector('[data-sw-agent-approval-dialog]')
  })
  const dialog = page.locator('[data-sw-agent-approval-dialog]')
  assert.match(await dialog.locator('[data-sw-agent-approval-mode="ask"]').textContent(), /Now: Edits on a branch, asking every time\./)
  const facts = dialog.locator('[data-sw-agent-machine="admins"]')
  assert.match(await facts.textContent(), /Set on the agent's machine/)
  assert.match(await facts.locator('[data-sw-agent-machine-fact="approvals"]').textContent(), /Admins of this project may answer\./)
  assert.match(await facts.locator('[data-sw-agent-machine-fact="commands"]').textContent(), /None\. It only asks to edit files\./)
  assert.match(await facts.locator('[data-sw-agent-machine-fact="auto"]').textContent(), /Nothing\./)
  assert.equal(await dialog.locator('[data-sw-agent-approval-option="ask"]').getAttribute('aria-checked'), 'true')
  assert.match(await dialog.locator('[data-sw-agent-approval-option="ask"]').textContent(), /Ask every time/)
  const auto = dialog.locator('[data-sw-agent-approval-option="auto"]')
  assert.equal(await auto.getAttribute('aria-disabled'), 'true')
  assert.equal(await auto.getAttribute('aria-checked'), 'false')
  assert.match(await auto.textContent(), /Allow without asking \(not available\)/)
  assert.match(
    await auto.locator('[data-sw-agent-approval-why]').textContent(),
    /Builder's machine did not say anything may go without asking/,
  )
  assert.match(await auto.textContent(), /shapewall agent connect --approvals owner --auto edits/)
  assert.doesNotMatch(await dialog.textContent(), /No connected agent can do that yet/)
  // Clicking it changes nothing: Save stays off.
  await auto.click({ force: true })
  assert.equal(await auto.getAttribute('aria-checked'), 'false')
  assert.equal(await page.isDisabled('[data-sw-agent-approval-save]'), true)
  await shots(list, 'console-approvals-dialog')
  if (list[2])
    assert.equal(
      await list[2].page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'no sideways scroll on a phone',
    )
  // The server agrees: the rule cannot be set from here. (Ada's passkey was
  // used in a browser above, so its counter moved on: the session is made
  // fresh in the database instead of by the test's own copy of the key.)
  hosted.rateLimiter.reset()
  hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date().toISOString())
  const refused = await ada.browser.call('PUT', consoleUrl(`/agents/${builder.agentId}/approval`), { body: { rule: 'auto' } })
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.error.code, 'approval_auto_unavailable')
  assert.deepEqual(realErrors(errors), [])
})
