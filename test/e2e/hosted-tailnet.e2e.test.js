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
import { believedGate } from '../tailnet-helpers.js'
import { startHostedServer } from '../hosted-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let hosted
let plain
let browser
const contexts = []

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the tailnet e2e test')
  // Two servers with tailnet sign-in: one where the operator also allowed passkeys, and one as it starts
  // by default, where Tailscale is the only sign-in.
  hosted = await startHostedServer('hosted-tailnet-e2e', { tailnet: believedGate(), tailnetPasskeys: true })
  plain = await startHostedServer('hosted-tailnet-only-e2e', { tailnet: believedGate() })
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})
after(async () => {
  for (const context of contexts) await context.close()
  await browser?.close()
  await hosted?.close()
  await plain?.close()
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

  // On the server's own machine the tailnet says who owns the machine, and the server does not take it: the
  // page says why and offers the passkey. Desktop and phone width.
  for (const [width, height, name] of [
    [1440, 900, '9-own-machine'],
    [390, 844, '10-own-machine-phone'],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      extraHTTPHeaders: { 'Tailscale-User-Login': 'ada@example.com', 'Tailscale-User-Name': 'Ada', 'X-Fixture-Own-Machine': '1' },
    })
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(hosted.origin + '/')
    const notice = page.locator('[data-sw-tailnet="self"]')
    await notice.waitFor()
    assert.match(await notice.innerText(), /This is the server’s own machine/)
    assert.match(await notice.innerText(), /Sign in with a passkey here, or open the server from another of your tailnet devices/)
    assert.equal(await page.locator('[data-sw-tailnet-continue]').count(), 0, 'no "Continue as" from here')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
    await shot(page, name)
  }
})

test('tailnet sign-in as it is by default: Tailscale is the only sign-in, no passkey anywhere, and the few things that always ask take a typed name', async () => {
  // ---- The first owner: the setup link, opened through the tailnet. No passkey is offered. ----
  const ada = await person('ada@example.com', 'Ada Lovelace')
  await ada.page.goto(plain.app.locals.setupLink())
  await ada.page.waitForSelector('[data-sw-signup-tailnet-submit]')
  assert.match(await ada.page.textContent('[data-sw-signup-tailnet]'), /Your Tailscale account is the sign-in on this server/)
  assert.equal(await ada.page.locator('[data-sw-signup-submit]').count(), 0, 'no "Create a passkey and sign up"')
  assert.equal(await ada.page.locator('[data-sw-signup-link-tailnet]').count(), 0)
  await ada.page.fill('[data-sw-signup-workspace]', 'Team')
  await shot(ada.page, 'only-1-setup')
  await ada.page.click('[data-sw-signup-tailnet-submit]')
  await ada.page.waitForURL(/\/w\/ws_/)
  const ws = /\/w\/(ws_[a-f0-9]+)/.exec(ada.page.url())[1]

  // ---- Someone nobody invited: the sign-in page has no passkey form and no recovery link ----
  const ben = await person('ben@example.com', 'Ben', { width: 390, height: 844 })
  await ben.page.goto(plain.origin + '/signin')
  await ben.page.waitForSelector('[data-sw-signin-tailnet-only] [data-sw-tailnet="unknown"]')
  assert.match(await ben.page.textContent('[data-sw-signin-tailnet-only]'), /Your Tailscale account is the sign-in on this server/)
  for (const gone of ['[data-sw-passkey-signin]', '[data-sw-signin-autofill]', '[data-sw-recovery-handle]'])
    assert.equal(await ben.page.locator(gone).count(), 0, gone)
  assert.doesNotMatch(await ben.page.textContent('main'), /recovery code|Sign in with a passkey/i)
  assert.ok(await ben.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390')
  await shot(ben.page, 'only-2-sign-in-phone')

  // ---- The account page: how you sign in, no passkeys, no recovery codes ----
  await ada.page.goto(plain.origin + '/account')
  await ada.page.waitForSelector('[data-sw-account-tailnet="only"]')
  assert.match(
    await ada.page.textContent('[data-sw-account-tailnet="only"]'),
    /anything running as you on one of your tailnet devices can act as you here/,
  )
  for (const gone of ['[data-sw-passkeys]', '[data-sw-recovery]', '[data-sw-tailnet-unlink]'])
    assert.equal(await ada.page.locator(gone).count(), 0, gone)
  await shot(ada.page, 'only-3-account')

  // ---- Settings: nothing to switch on; what still asks is said ----
  await ada.page.goto(plain.origin + '/w/' + ws + '/settings')
  await ada.page.waitForSelector('[data-sw-settings-step-up="tailnet-only"]')
  assert.equal(await ada.page.locator('[data-sw-step-up-row]').count(), 0)
  assert.match(await ada.page.textContent('[data-sw-settings-step-up="tailnet-only"]'), /asks you to type the workspace’s name/)

  // ---- Inviting an owner: the server asks, the dialog takes the workspace's name ----
  await ada.page.goto(plain.origin + '/w/' + ws + '/invites')
  await ada.page.click('[data-sw-new-invite]')
  await ada.page.click('[data-sw-invite-role]')
  await ada.page.click('[role="option"][data-sw-option="owner"]')
  await ada.page.click('[data-sw-invite-create]')
  await ada.page.waitForSelector('[data-sw-confirm-required="workspace"]')
  assert.match(await ada.page.textContent('[data-sw-confirm-required="workspace"]'), /Type the workspace’s name, Team, to confirm/)
  assert.equal(await ada.page.locator('[data-sw-reauth], [data-sw-reauth-no-passkey], [data-sw-reauth-add-passkey]').count(), 0)
  assert.equal(await ada.page.isDisabled('[data-sw-confirm-typed]'), true, 'Confirm stays off until the name is typed')
  await ada.page.fill('[data-sw-confirm-typed-input]', 'team')
  assert.equal(await ada.page.isDisabled('[data-sw-confirm-typed]'), true, 'not another spelling')
  await ada.page.fill('[data-sw-confirm-typed-input]', 'Team')
  await shot(ada.page, 'only-4-type-to-confirm')
  await ada.page.click('[data-sw-confirm-typed]')
  await ada.page.waitForSelector('[data-sw-copy-value="invite"]')
  assert.equal(plain.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE role = 'owner'").get().n, 1)

  // ---- Deleting the workspace: its own dialog already takes the name, and that is the confirmation ----
  await ada.page.goto(plain.origin + '/w/' + ws + '/settings')
  await ada.page.click('[data-sw-delete-workspace]')
  await ada.page.fill('[data-sw-confirm-input]', 'Team')
  await ada.page.click('[data-sw-confirm]')
  await ada.page.waitForURL((url) => !url.pathname.includes(ws))
  assert.equal(plain.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 0)
  assert.equal(plain.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 0)
  for (const who of [ada, ben]) assert.deepEqual(who.errors, [])
})
