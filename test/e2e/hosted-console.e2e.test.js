// End to end, the hosted console's account pages: recovery codes that read one
// per line, a sign-in error that does not follow you into the recovery-code
// form, the recovery-code sign-in in its own words, Account activity and the
// passkey line in sentence case, and touch-size controls on Activity and Usage
// at phone width. A real browser with a virtual passkey authenticator.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startHostedServer } from '../hosted-helpers.js'
import { ROOT_DIR } from './helpers.js'

let hosted
let browser
let workspaceId
let code

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the hosted e2e test')
  hosted = await startHostedServer('hosted-console-e2e')
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await hosted?.close()
})

async function open({ width = 1440, height = 900, phone = false, storageState } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
    ...(storageState ? { storageState } : {}),
  })
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
  // Off: the authenticator waits, as a person would before picking a passkey
  // (passkey autofill then stays pending instead of signing straight in).
  const presence = (enabled) => cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled })
  // The passkey is lost: this browser holds none any more.
  const lose = () => cdp.send('WebAuthn.clearCredentials', { authenticatorId })
  return { context, page, errors, presence, lose }
}

let ownerState
test('recovery codes, a sign-in error left behind, a recovery-code sign-in and Account activity in sentence case', async () => {
  const { context, page, errors, presence, lose } = await open()
  const link = new URL(hosted.app.locals.setupLink())
  await page.goto(`${hosted.origin}${link.pathname}${link.hash}`)
  await page.fill('[data-sw-signup-handle]', 'olive')
  await page.fill('[data-sw-signup-name]', 'Olive Owner')
  await page.click('[data-sw-signup-submit]')
  await page.waitForSelector('[data-sw-recovery-codes]')
  // Each code on one line: the list never breaks a code in two at desktop width.
  const lines = await page.$$eval('[data-sw-recovery-code-item] .sw-secret', (items) =>
    items.map((item) => Math.round(item.getBoundingClientRect().height / parseFloat(getComputedStyle(item).lineHeight))),
  )
  assert.deepEqual(lines, Array(10).fill(1))
  code = (await page.locator('[data-sw-recovery-code-item] .sw-secret').first().textContent()).trim()
  await page.click('#saved')
  await page.click('[data-sw-codes-done]')
  await page.waitForURL(/\/w\/ws_/)
  workspaceId = /\/w\/(ws_[a-f0-9]{24})/.exec(page.url())[1]

  // Sign out from the account menu, and lose the passkey.
  await presence(false)
  await lose()
  await page.click('[data-sw-account-menu]')
  await page.click('[data-sw-sign-out]')
  await page.waitForURL(/\/signin/)

  // A passkey sign-in that fails, then "Lost your passkey?": the passkey's error stays behind.
  await page.route('**/auth/login/options', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"down","message":"The server is busy."}}' }),
  )
  await page.click('[data-sw-passkey-signin]')
  await page.waitForSelector('[data-sw-error]:has-text("The server is busy.")')
  await page.unroute('**/auth/login/options')
  await page.click('text=Lost your passkey? Use a recovery code')
  await page.waitForSelector('[data-sw-recovery-code]')
  assert.equal(await page.locator('[data-sw-error]').count(), 0, 'no passkey error under the recovery-code form')
  assert.equal((await page.textContent('h1')).trim(), 'Sign in with a recovery code')
  // Back, and the form is clean again.
  await page.click('button:has-text("Back")')
  await page.waitForSelector('[data-sw-passkey-signin]')
  assert.equal(await page.locator('[data-sw-error]').count(), 0)
  assert.equal((await page.textContent('h1')).trim(), 'Sign in')

  await page.click('text=Lost your passkey? Use a recovery code')
  await page.fill('[data-sw-recovery-handle]', 'olive')
  await page.fill('[data-sw-recovery-code]', code)
  await page.click('button:has-text("Sign in with the code")')
  await page.waitForURL(/\/account/)
  await page.waitForSelector('[data-sw-security-event="signed_out"]')
  const labels = await page.$$eval('[data-sw-security-event] p.text-sm', (items) => items.map((item) => item.textContent.trim()))
  assert.ok(labels.includes('Signed out'), labels.join(' | '))
  assert.ok(labels.includes('Signed in with a recovery code'), labels.join(' | '))
  for (const label of labels) assert.match(label, /^[A-Z][a-z]/, label)
  // The passkey's line starts with a capital: "Built-in · Added ...".
  assert.match((await page.textContent('[data-sw-passkey]')).replace(/\s+/g, ' '), /Built-in · Added/)

  await presence(true)
  // A passkey added in this recovery session is on hold: removing the old one
  // says so, and offers no second "Add a passkey" that would be on hold too.
  await page.click('[data-sw-add-passkey]')
  await page.fill('[data-sw-passkey-name]', 'Laptop')
  await page.click('[data-sw-passkey-create]')
  await page.waitForSelector('[data-sw-passkey]:has-text("Laptop")')
  const remove = page.locator('[data-sw-passkey]', { hasText: 'First passkey' }).getByRole('button', { name: /Remove/ })
  await remove.click()
  await page.click('[data-sw-confirm]')
  await page.waitForSelector('[data-sw-reauth-held]')
  assert.equal((await page.textContent('[role="dialog"]:has([data-sw-reauth-held]) h2')).trim(), 'Your new passkey is on hold')
  assert.equal(await page.locator('[data-sw-reauth-add-passkey]').count(), 0)
  await page.click('[data-sw-reauth-close]')
  await page.waitForSelector('[data-sw-reauth-held]', { state: 'detached' })
  // Back on the remove confirm, which stays until it is answered.
  await page.click('[role="dialog"] button:has-text("Cancel")')
  await page.waitForSelector('[role="dialog"]', { state: 'detached' })
  assert.equal(await page.locator('[data-sw-passkey]').count(), 2, 'nothing was removed')

  // Any dialog: Escape puts focus back on the button that opened it.
  await page.goto(hosted.origin + '/w/' + workspaceId + '/invites')
  await page.focus('[data-sw-new-invite]')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[role="dialog"]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="dialog"]', { state: 'detached' })
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-new-invite')), true)

  // The first Tab stop skips the sidebar and the header.
  await page.goto(hosted.origin + '/w/' + workspaceId + '/projects')
  await page.waitForSelector('[data-sw-skip-link]', { state: 'attached' })
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-sw-skip-link')), true)
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main')
  // The 503s are the made-up outage above, the 403 the refused removal: both expected.
  assert.deepEqual(
    errors.filter((text) => !/Failed to load resource: the server responded with a status of (503|403)/.test(text)),
    [],
  )
  ownerState = await context.storageState()
  await context.close()
})

test('Activity and Usage at phone width: controls are touch size', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844, phone: true, storageState: ownerState })
  const small = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('main button, main a[href], main [role="combobox"], main [role="radio"], main input')]
        .filter((el) => el.getClientRects().length && !el.closest('p') && !el.closest('[data-sw-usage-grid]'))
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map(
          (el) =>
            `${(el.getAttribute('aria-label') || el.textContent || el.placeholder).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}`,
        ),
    )
  await page.goto(`${hosted.origin}/w/${workspaceId}/activity`)
  await page.waitForSelector('[data-sw-activity-search]')
  assert.deepEqual(await small(), [], 'Activity')
  await page.goto(`${hosted.origin}/w/${workspaceId}/usage`)
  await page.waitForSelector('[data-sw-usage-filters]')
  assert.deepEqual(await small(), [], 'Usage')
  assert.deepEqual(errors, [])
  await context.close()
})
