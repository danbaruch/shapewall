// End to end, the hosted console's account pages: recovery codes that read one
// per line, a sign-in error that does not follow you into the recovery-code
// form, the recovery-code sign-in in its own words, Account activity and the
// passkey line in sentence case, and touch-size controls on Activity and Usage
// at phone width, and one look across the console (the workspace name once, a
// 44 px logo, one shown-once notice, one danger pattern, a taken handle at its
// field). A real browser with a virtual passkey authenticator.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createProject, invite, reauth, signUp, startHostedServer } from '../hosted-helpers.js'
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

// One look across the console: the workspace's name once (in the switcher), a finger-size logo on a phone, one
// notice beside every secret shown once, one pattern for every danger zone, and a taken handle said at its field.
test('console consistency: one workspace name, a 44 px logo, one shown-once notice, one danger pattern, a taken handle at its field', async () => {
  const other = await startHostedServer('hosted-console-consistency-e2e')
  try {
    const owner = await signUp(other, { handle: 'nia', displayName: 'Nia' })
    const ws = owner.workspaceId
    await owner.browser.call('PATCH', `/api/workspaces/${ws}`, { body: { name: 'North Studio' } })
    await reauth(owner)
    const project = await createProject(owner, ws, 'Site')
    const visit = async (options) => {
      const context = await browser.newContext({
        viewport: { width: options.width, height: options.height },
        ...(options.phone ? { isMobile: true, hasTouch: true } : {}),
      })
      if (options.signedIn) await context.addCookies([...owner.browser.jar].map(([name, value]) => ({ name, value, url: other.origin })))
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      return { context, page, errors }
    }
    // Where the workspace's name is drawn as text on the page (not in a closed menu).
    const names = (page) =>
      page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.includes('North Studio')))
          .filter((node) => node.getClientRects().length)
          .map((node) => node.textContent.trim()),
      )

    // A desktop: the name once, in the switcher; the sidebar says "Workspace".
    const desk = await visit({ width: 1440, height: 900, signedIn: true })
    await desk.page.goto(`${other.origin}/w/${ws}`)
    await desk.page.waitForSelector('[data-sw-workspace-switcher]')
    assert.deepEqual(await names(desk.page), ['North Studio'])
    assert.equal((await desk.page.textContent('[data-sw-rail-title]')).trim(), 'Shapewall')

    // Every danger zone the same: a red-edged card, one outlined danger button of one size.
    const danger = async (selector) => {
      const button = desk.page.locator(selector)
      await button.waitFor()
      return button.evaluate((node) => {
        const style = getComputedStyle(node)
        return {
          zone: Boolean(node.closest('[data-sw-danger-card]')),
          pattern: node.hasAttribute('data-sw-danger-action'),
          border: style.borderTopWidth,
          height: node.getBoundingClientRect().height,
          color: style.color,
        }
      })
    }
    await desk.page.goto(`${other.origin}/w/${ws}/projects/${project.id}`)
    const deleteProject = await danger('[data-sw-delete-project]')
    await desk.page.goto(`${other.origin}/w/${ws}/settings`)
    const deleteWorkspace = await danger('[data-sw-delete-workspace]')
    await desk.page.goto(`${other.origin}/account`)
    const deleteAccount = await danger('[data-sw-delete-account-open]')
    assert.deepEqual(deleteProject, { zone: true, pattern: true, border: '1px', height: 36, color: deleteProject.color })
    assert.deepEqual(deleteWorkspace, deleteProject, 'Delete workspace looks like Delete project')
    assert.deepEqual(deleteAccount, deleteProject, 'Delete account looks like Delete project')

    // A new token and a new invite link: the same notice, in the same tone.
    const notice = () =>
      desk.page
        .locator('[role="dialog"] [data-sw-shown-once]')
        .evaluate((node) => ({ title: node.querySelector('p').textContent, classes: node.className }))
    await reauth(owner)
    await desk.page.goto(`${other.origin}/w/${ws}/tokens`)
    await desk.page.click('[data-sw-new-token]')
    await desk.page.fill('[data-sw-token-name]', 'CI')
    await desk.page.click('[data-sw-token-create]')
    await desk.page.waitForSelector('[data-sw-token-done]')
    const tokenNotice = await notice()
    await desk.page.click('[data-sw-token-done]')
    await reauth(owner)
    await desk.page.goto(`${other.origin}/w/${ws}/invites`)
    await desk.page.click('[data-sw-new-invite]')
    await desk.page.click('[data-sw-invite-create]')
    await desk.page.waitForSelector('[data-sw-copy="invite"]')
    const inviteNotice = await notice()
    assert.equal(tokenNotice.title, 'Copy it now: it is shown once')
    assert.deepEqual(inviteNotice, tokenNotice)
    assert.deepEqual(desk.errors, [])
    await desk.context.close()

    // A phone: the logo is a 44 px target around a 28 px mark, and the name is still said once.
    const phone = await visit({ width: 390, height: 844, phone: true, signedIn: true })
    await phone.page.goto(`${other.origin}/w/${ws}`)
    await phone.page.waitForSelector('[data-sw-header-home]')
    const home = await phone.page.locator('[data-sw-header-home]').boundingBox()
    const mark = await phone.page.locator('[data-sw-header-home] svg').boundingBox()
    assert.ok(home.width >= 44 && home.height >= 44, `logo target ${home.width}x${home.height}`)
    assert.equal(Math.round(mark.width), 28)
    assert.deepEqual(await names(phone.page), ['North Studio'])
    await phone.context.close()

    // Sign-up with a handle someone has: said under the field, which is marked invalid, described by it and focused.
    await reauth(owner)
    const token = (await invite(owner, ws, 'member')).replace(/^invite=/, '')
    const guest = await visit({ width: 1440, height: 900 })
    await guest.page.goto(`${other.origin}/signup#invite=${token}`)
    await guest.page.fill('[data-sw-signup-handle]', 'nia')
    await guest.page.fill('[data-sw-signup-name]', 'Another Nia')
    await guest.page.click('[data-sw-signup-submit]')
    const field = guest.page.locator('[data-sw-signup-handle]')
    await guest.page.waitForFunction(() => document.querySelector('[data-sw-signup-handle]')?.getAttribute('aria-invalid') === 'true')
    const wired = await field.evaluate((input) => ({
      focused: document.activeElement === input,
      said: (input.getAttribute('aria-describedby') || '').split(' ').map((id) => document.getElementById(id)?.textContent),
    }))
    assert.equal(wired.focused, true, 'the field has the focus')
    assert.ok(wired.said.includes('That handle is taken.'), wired.said.join(' | '))
    assert.equal(await guest.page.locator('[data-sw-error]').count(), 0, 'not said again under the form')
    assert.ok(await guest.page.locator('[data-sw-signup-submit]').isDisabled(), 'the same handle cannot be sent again')
    // Another handle: the error goes.
    await field.fill('nia-two')
    assert.equal(await field.getAttribute('aria-invalid'), null)
    assert.equal(await guest.page.locator('text=That handle is taken.').count(), 0)
    assert.deepEqual(guest.errors, [])
    await guest.context.close()
  } finally {
    await other.close()
  }
})
