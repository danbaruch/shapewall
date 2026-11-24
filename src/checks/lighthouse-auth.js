import fs from 'node:fs'
import { fingerprint } from './schema.js'

export class AuditTargetError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const unsupported = () => {
  throw new AuditTargetError('unsupported-auth')
}
const cookieKeys = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'])

// Playwright storage state is not a Lighthouse flag. Translate only the
// cookie and localStorage state supported by this prepared Chromium adapter.
export function translateStorageState(input) {
  let state = input
  if (typeof input === 'string') {
    if (fs.statSync(input).size > 1024 * 1024) unsupported()
    state = JSON.parse(fs.readFileSync(input, 'utf8'))
  }
  if (!state) unsupported()
  if (
    Object.keys(state).some((key) => !['cookies', 'origins'].includes(key)) ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins) ||
    state.cookies.length > 200 ||
    state.origins.length > 20
  )
    unsupported()
  const cookies = state.cookies.map((cookie) => {
    if (!cookie || Object.keys(cookie).some((key) => !cookieKeys.has(key))) unsupported()
    if (![cookie.name, cookie.value, cookie.domain, cookie.path].every((s) => typeof s === 'string')) unsupported()
    if (!['Strict', 'Lax', 'None', undefined].includes(cookie.sameSite)) unsupported()
    if (cookie.expires !== undefined && !Number.isFinite(cookie.expires)) unsupported()
    const converted = { ...cookie }
    if (converted.expires === -1) delete converted.expires
    return converted
  })
  const origins = state.origins.map((entry) => {
    if (
      !entry ||
      (Object.hasOwn(entry, 'indexedDB') && (!Array.isArray(entry.indexedDB) || entry.indexedDB.length)) ||
      Object.keys(entry).some((key) => !['origin', 'localStorage', 'indexedDB'].includes(key))
    )
      unsupported()
    let url
    try {
      url = new URL(entry.origin)
    } catch {
      unsupported()
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      entry.origin !== url.origin ||
      !Array.isArray(entry.localStorage) ||
      entry.localStorage.length > 200
    )
      unsupported()
    for (const item of entry.localStorage) if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') unsupported()
    return { origin: entry.origin, localStorage: entry.localStorage.map(({ name, value }) => ({ name, value })) }
  })
  if (Buffer.byteLength(JSON.stringify({ cookies, origins })) > 1024 * 1024) unsupported()
  return { cookies, origins, hash: fingerprint({ cookies, origins }) }
}

export async function applyStorageState(page, prepared) {
  if (prepared.cookies.length) await page.browserContext().setCookie(...prepared.cookies)
  if (prepared.origins.length)
    await page.evaluateOnNewDocument((origins) => {
      // eslint-disable-next-line no-undef -- evaluated in the target browser
      const entry = origins.find((item) => item.origin === location.origin)
      if (entry) for (const item of entry.localStorage) localStorage.setItem(item.name, item.value)
    }, prepared.origins)
}

export function sameTarget(actual, expected) {
  try {
    const a = new URL(actual),
      b = new URL(expected)
    const pathname = (url) => url.pathname.replace(/\/+$/, '') || '/'
    return a.origin === b.origin && pathname(a) === pathname(b) && a.search === b.search
  } catch {
    return false
  }
}

// Lighthouse runs the original action set only; the app-capture actions and
// options (tap, mouse, hold, waitForFunction, optional, viewports, ...) and a
// page timeout or localStorage seed are reported as unsupported, not half-run.
const LIGHTHOUSE_ACTIONS = ['click', 'fill', 'press', 'hover', 'wait', 'waitFor', 'scrollTo']
export function assertSupportedActions(page) {
  if (
    page.localStorage ||
    (page.actions || []).some(
      (action) => !LIGHTHOUSE_ACTIONS.includes(action.type) || action.optional || action.viewports || action.force || action.timeout,
    )
  )
    throw new AuditTargetError('unsupported-actions')
  const selectors = [page.waitFor, ...(page.actions || []).map((action) => action.selector)].filter(Boolean)
  if (selectors.some((selector) => /^(?:text|role|xpath|id|data-testid)=|>>|:has-text\(/.test(selector)))
    throw new AuditTargetError('unsupported-actions')
}

export async function verifyTarget(page, expected, pageConfig, timeout) {
  if (!sameTarget(page.url(), expected)) throw new AuditTargetError('wrong-target')
  if (pageConfig.waitFor) {
    try {
      await page.waitForSelector(pageConfig.waitFor, { visible: true, timeout })
    } catch {
      throw new AuditTargetError('not-ready')
    }
  }
  if (!sameTarget(page.url(), expected)) throw new AuditTargetError('wrong-target')
}

export async function runConfiguredActions(page, actions, timeout) {
  for (const action of actions || []) {
    if (action.type === 'click') await page.locator(action.selector).setTimeout(timeout).click()
    else if (action.type === 'fill') await page.locator(action.selector).setTimeout(timeout).fill(action.value)
    else if (action.type === 'hover') await page.locator(action.selector).setTimeout(timeout).hover()
    else if (action.type === 'wait') await new Promise((resolve) => setTimeout(resolve, action.ms))
    else if (action.type === 'waitFor') await page.waitForSelector(action.selector, { visible: true, timeout })
    // eslint-disable-next-line no-undef -- evaluated in the target browser
    else if (action.type === 'scrollTo') await page.evaluate((y) => scrollTo(0, y), action.y)
    else if (action.type === 'press') {
      const keys = action.key.split('+'),
        key = keys.pop(),
        held = []
      try {
        for (const modifier of keys) {
          const name = modifier === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : modifier
          if (!['Control', 'Meta', 'Alt', 'Shift'].includes(name)) throw new AuditTargetError('unsupported-actions')
          await page.keyboard.down(name)
          held.push(name)
        }
        await page.keyboard.press(key)
      } finally {
        for (const modifier of held.reverse()) await page.keyboard.up(modifier)
      }
    } else throw new AuditTargetError('unsupported-actions')
  }
}
