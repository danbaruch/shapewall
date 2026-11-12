// Tailnet sign-in in a real browser: the first owner with the setup link and
// no passkey, a visitor nobody invited, the admin who admits them with a
// role, joining, signing out and "Continue as", and linking a passkey
// account. There is no tailnet here: each browser context sends the headers
// tailscale serve would add, and this test's server believes every
// connection (test/hosted-tailnet.test.js covers when it must not).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { chromium } from 'playwright'
import { createTailnetGate } from '../../src/hosted/tailnet-identity.js'
import { startHostedServer } from '../hosted-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let hosted
let browser
const contexts = []

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the tailnet e2e test')
  hosted = await startHostedServer('hosted-tailnet-e2e', { tailnet: createTailnetGate({ proof: { trusted: () => true } }) })
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})
after(async () => {
  for (const context of contexts) await context.close()
  await browser?.close()
  await hosted?.close()
})

const shot = async (page, name) =>
  SHOTS && page.screenshot({ path: path.join(SHOTS, `tailnet-${name}.png`), fullPage: true, animations: 'disabled' })

// A browser on a device of `login` (null: not through the tailnet), with a passkey authenticator.
async function person(login, name, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(login ? { extraHTTPHeaders: { 'Tailscale-User-Login': login, 'Tailscale-User-Name': name } } : {}),
  })
  contexts.push(context)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/status of 40[134]/.test(message.text())) errors.push(message.text())
  })
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
  return { context, page, errors }
}

test('tailnet sign-in: the owner claims with no passkey, a visitor is admitted with a role, signs out and continues, and a passkey account links', async () => {
  // ---- The first owner: the setup link, opened through the tailnet ----
  const ada = await person('ada@example.com', 'Ada Lovelace')
  await ada.page.goto(hosted.app.locals.setupLink())
  await ada.page.waitForSelector('[data-sw-signup-tailnet-submit]')
  assert.match(await ada.page.textContent('[data-sw-signup-tailnet]'), /Your tailnet signs you in as ada@example\.com/)
  assert.equal(await ada.page.inputValue('[data-sw-signup-handle]'), 'ada', 'the handle is suggested from the login')
  await ada.page.fill('[data-sw-signup-workspace]', 'Team')
  await shot(ada.page, '1-setup')
  await ada.page.click('[data-sw-signup-tailnet-submit]')
  await ada.page.waitForURL(/\/w\/ws_/)
  const ws = /\/w\/(ws_[a-f0-9]+)/.exec(ada.page.url())[1]
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0, 'no passkey was made')
  assert.equal(hosted.db.prepare('SELECT tailnet_login FROM users').get().tailnet_login, 'ada@example.com')

  // Settings shows the command line switch on a server with tailnet sign-in; the fixed core asks her to add a passkey first.
  await ada.page.goto(`${hosted.origin}/w/${ws}/settings`)
  await ada.page.waitForSelector('[data-sw-step-up-row="cliApproval"]')
  await ada.page.locator('[data-sw-step-up-row="cliApproval"]').getByRole('switch').click()
  await ada.page.locator('[data-sw-step-up-row="cliApproval"] [data-sw-switch="on"]').waitFor()
  await ada.page.locator('[data-sw-step-up-row="cliApproval"]').getByRole('switch').click()
  await ada.page.waitForSelector('[data-sw-reauth-no-passkey]')
  assert.match(await ada.page.textContent('[data-sw-reauth-no-passkey]'), /always needs a passkey, and your account has none/)
  assert.equal(await ada.page.locator('[data-sw-reauth]').count(), 0, 'not asked for a passkey she does not have')
  await shot(ada.page, '2-add-a-passkey-first')
  await ada.page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  // ---- A tailnet user nobody invited ----
  const ben = await person('ben@example.com', 'Ben')
  await ben.page.goto(`${hosted.origin}/`)
  await ben.page.waitForSelector('[data-sw-tailnet="unknown"]')
  assert.match(await ben.page.textContent('[data-sw-tailnet="unknown"]'), /Ask an admin of a workspace here to invite ben@example\.com/)
  assert.equal(await ben.page.locator('[data-sw-tailnet-join]').count(), 0, 'nothing to press: being on the tailnet gives nothing')
  await shot(ben.page, '3-unknown')

  // ---- The admin sees who arrived and admits with a role ----
  await ada.page.goto(`${hosted.origin}/w/${ws}/members`)
  await ada.page.waitForSelector('[data-sw-tailnet-visitor="ben@example.com"]')
  await shot(ada.page, '4-visitors')
  await ada.page.click('[data-sw-tailnet-admit]')
  await ada.page.waitForSelector('[data-sw-tailnet-visitors]', { state: 'detached' })
  await ada.page.goto(`${hosted.origin}/w/${ws}/invites`)
  assert.match(await ada.page.textContent('[data-sw-invite-tailnet]'), /For the tailnet login ben@example\.com/)

  // ---- The visitor comes back: invited, joins with one press ----
  await ben.page.goto(`${hosted.origin}/`)
  await ben.page.waitForSelector('[data-sw-tailnet="invited"]')
  assert.match(await ben.page.textContent('[data-sw-tailnet="invited"]'), /You are invited: Team as a member/)
  await shot(ben.page, '5-invited')
  await ben.page.click('[data-sw-tailnet-join]')
  await ben.page.waitForURL(new RegExp(`/w/${ws}`))
  assert.equal(
    hosted.db.prepare("SELECT role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.handle = 'ben'").get().role,
    'member',
  )
  await ben.page.goto(`${hosted.origin}/account`)
  await ben.page.waitForSelector('[data-sw-session-tailnet]')
  assert.match(await ben.page.textContent('[data-sw-account-tailnet]'), /Linked to ben@example\.com.*You are signed in that way now/s)

  // ---- Signing out stays signed out until "Continue as" ----
  await ben.context.request.post(`${hosted.origin}/auth/logout`, { data: {}, headers: { Origin: hosted.origin } })
  await ben.page.goto(`${hosted.origin}/w/${ws}`)
  await ben.page.waitForSelector('[data-sw-tailnet="signed_out"]')
  assert.match(await ben.page.textContent('[data-sw-tailnet="signed_out"]'), /arriving here would sign you\s+straight back in/)
  await shot(ben.page, '6-signed-out')
  await ben.page.click('[data-sw-tailnet-continue]')
  await ben.page.waitForURL(new RegExp(`/w/${ws}`))

  // ---- A passkey account links its login, with one click while it arrives through the tailnet ----
  const invite = await (
    await ada.context.request.post(`${hosted.origin}/api/workspaces/${ws}/invites`, {
      data: { role: 'member' },
      headers: { Origin: hosted.origin },
    })
  ).json()
  const cyd = await person(null)
  await cyd.page.goto(invite.url)
  await cyd.page.goto(`${hosted.origin}/signup`)
  await cyd.page.waitForSelector('[data-sw-signup-handle]')
  assert.equal(await cyd.page.locator('[data-sw-signup-tailnet-submit]').count(), 0, 'off the tailnet: a passkey, as on any server')
  await cyd.page.fill('[data-sw-signup-handle]', 'cyd')
  await cyd.page.fill('[data-sw-signup-name]', 'Cyd')
  await cyd.page.click('[data-sw-signup-submit]')
  await cyd.page.waitForSelector('[data-sw-codes-done]')
  await cyd.context.setExtraHTTPHeaders({ 'Tailscale-User-Login': 'cyd@example.com', 'Tailscale-User-Name': 'Cyd' })
  await cyd.page.goto(`${hosted.origin}/account`)
  await cyd.page.waitForSelector('[data-sw-tailnet-link]')
  await shot(cyd.page, '7-link')
  await cyd.page.click('[data-sw-tailnet-link]')
  await cyd.page.waitForSelector('[data-sw-tailnet-unlink]')
  assert.equal(hosted.db.prepare("SELECT tailnet_login FROM users WHERE handle = 'cyd'").get().tailnet_login, 'cyd@example.com')

  // At phone width the first-visit page fits.
  const dee = await person('dee@example.com', 'Dee', { width: 390, height: 844 })
  await dee.page.goto(`${hosted.origin}/`)
  await dee.page.waitForSelector('[data-sw-tailnet="unknown"]')
  assert.ok(await dee.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390')
  await shot(dee.page, '8-unknown-phone')
  for (const who of [ada, ben, cyd, dee]) assert.deepEqual(who.errors, [])
})
