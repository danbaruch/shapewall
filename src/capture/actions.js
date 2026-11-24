// Runs a page's configured actions (src/config.js validates them) in a
// Playwright page, for captures, setup and page checks alike.
//
// A failure names the step: `action 3 (click "button:has-text('Play')") timed
// out after 45 s`. Messages are built from the config only: page text,
// Playwright's call log (which quotes page markup) and exceptions thrown by a
// waitForFunction expression never reach the manifest or the board.

// An optional action that is not there gives up after this long (unless it
// sets its own `timeout`).
export const OPTIONAL_TIMEOUT_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value, max = 80) => JSON.stringify(String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value))
export const seconds = (ms) => `${Math.round(ms / 100) / 10} s`

// One line per action, for logs and errors.
export function describeAction(action) {
  switch (action.type) {
    case 'wait':
      return `wait ${action.ms} ms`
    case 'scrollTo':
      return `scrollTo ${action.y}`
    case 'mouse':
      return `mouse ${action.x}, ${action.y}`
    case 'hold':
      return `hold ${quote(action.key)} ${action.ms} ms`
    case 'press':
    case 'keyDown':
    case 'keyUp':
      return `${action.type} ${quote(action.key)}`
    case 'waitForFunction':
      return `waitForFunction ${quote(action.expression, 60)}`
    default:
      return `${action.type} ${quote(action.selector)}`
  }
}

// How long an action may take: its own timeout, else a short one when it
// is optional, else the page's.
export const actionTimeout = (action, timeout) => action.timeout ?? (action.optional ? Math.min(OPTIONAL_TIMEOUT_MS, timeout) : timeout)

export const isTimeout = (error) => error?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(String(error?.message || ''))

// A short, config-only reason for a failed step.
export function stepFailure(label, error, timeout, { pageCode = false } = {}) {
  const message = String(error?.message || error || '')
  if (isTimeout(error)) {
    // Playwright retries a click on a covered element until the timeout.
    const covered = /intercepts pointer events/.test(message)
      ? '; another element covers it (a canvas or overlay): try "force": true, or a "mouse" click at its position'
      : ''
    return new StepError(`${label} timed out after ${seconds(timeout)}${covered}`)
  }
  if (/has been closed|Target closed/i.test(message)) return new StepError(`${label} stopped: the page was closed`)
  if (/does not support tap/i.test(message)) return new StepError(`${label} failed: tap needs a touch viewport`)
  // An expression's own exception is page output: keep it out.
  if (pageCode) return new StepError(`${label} failed: the expression threw in the page`)
  const first = message
    .split('\n')[0]
    .replace(/^\w+\.\w+:\s*/, '')
    .slice(0, 160)
  return new StepError(`${label} failed${first ? `: ${first}` : ''}`)
}

export class StepError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StepError'
  }
}

// A forced click goes to the element itself: pointer, mouse and click events
// dispatched on it, so a canvas or overlay on top (a game's render surface)
// cannot swallow it. A coordinate click ("mouse") hits whatever is on top.
const FORCED_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
async function forceClick(page, selector, timeout) {
  const target = page.locator(selector).first()
  await target.waitFor({ state: 'attached', timeout })
  const box = await target.boundingBox().catch(() => null)
  const point = box ? { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 } : {}
  for (const type of FORCED_EVENTS) {
    await target.dispatchEvent(type, { button: 0, isPrimary: true, pointerType: 'mouse', ...point }, { timeout })
  }
}

async function runOne(page, action, timeout) {
  const force = action.force ? { force: true } : {}
  switch (action.type) {
    case 'click':
      return action.force ? forceClick(page, action.selector, timeout) : page.click(action.selector, { timeout })
    case 'tap':
      return page.tap(action.selector, { timeout, ...force })
    case 'fill':
      return page.fill(action.selector, action.value, { timeout, ...force })
    case 'hover':
      return page.hover(action.selector, { timeout, ...force })
    case 'press':
      return page.keyboard.press(action.key)
    case 'keyDown':
      return page.keyboard.down(action.key)
    case 'keyUp':
      return page.keyboard.up(action.key)
    case 'hold':
      await page.keyboard.down(action.key)
      try {
        await sleep(action.ms)
      } finally {
        await page.keyboard.up(action.key).catch(() => {})
      }
      return undefined
    case 'mouse':
      return page.mouse.click(action.x, action.y)
    case 'wait':
      return sleep(action.ms)
    case 'waitFor':
      return page.waitForSelector(action.selector, { timeout, state: 'visible' })
    case 'waitForFunction': {
      // Only "it became truthy" comes back; the value itself is dropped in the page.
      const handle = await page.waitForFunction(action.expression, undefined, { timeout, polling: 100 })
      await handle.dispose().catch(() => {})
      return undefined
    }
    case 'scrollTo':
      // A function, not a string: a string is evaluated as an expression and never called.
      return page.evaluate((y) => globalThis.scrollTo(0, y), action.y)
    default:
      throw new Error(`unknown action ${action.type}`)
  }
}

// Runs `actions` in order. `viewport` skips actions guarded to other
// viewports; optional actions that fail are skipped. `label` prefixes errors
// ("action", "setup action"); `onStep(text)` hears each step as it starts.
// Returns { skipped: [1-based numbers of optional actions that were skipped] }.
export async function runActions(page, actions, { timeout, viewport = null, label = 'action', onStep = () => {} } = {}) {
  const skipped = []
  for (const [index, action] of (actions || []).entries()) {
    const result = await runAction(page, action, index, { timeout, viewport, label, onStep })
    if (result === 'skipped') skipped.push(index + 1)
  }
  return { skipped }
}

// One action (index from 0). Returns 'ran', 'not-here' (guarded to other
// viewports) or 'skipped' (optional and absent); throws a StepError otherwise.
export async function runAction(page, action, index, { timeout, viewport = null, label = 'action', onStep = () => {} } = {}) {
  if (viewport && action.viewports && !action.viewports.includes(viewport)) return 'not-here'
  const step = `${label} ${index + 1} (${describeAction(action)})`
  onStep(step)
  const limit = actionTimeout(action, timeout)
  try {
    await runOne(page, action, limit)
    return 'ran'
  } catch (error) {
    if (action.optional) return 'skipped'
    throw stepFailure(step, error, limit, { pageCode: action.type === 'waitForFunction' })
  }
}
