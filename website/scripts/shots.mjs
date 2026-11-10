// Looks at every built page in Chromium at phone and desktop width: full-page screenshots, console errors, failed
// requests and horizontal overflow. Dev tool (needs Playwright from the CLI package): node scripts/shots.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from './serve.mjs'
import { ROUTES } from '../src/routes.js'

const out = path.resolve(process.argv[2] || 'shots')
fs.mkdirSync(out, { recursive: true })
const server = createServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch()
const problems = []
try {
  for (const [name, viewport, mobile] of [
    ['390', { width: 390, height: 844 }, true],
    ['1440', { width: 1440, height: 900 }, false],
  ]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile })
    for (const route of [...ROUTES.map((r) => r.path), '/nope']) {
      const page = await context.newPage()
      page.on('console', (message) => {
        if (['error', 'warning'].includes(message.type())) problems.push(`${name} ${route} console ${message.type()}: ${message.text()}`)
      })
      page.on('pageerror', (error) => problems.push(`${name} ${route} pageerror: ${error.message}`))
      page.on('requestfailed', (request) => problems.push(`${name} ${route} failed: ${request.url()}`))
      page.on('response', (response) => {
        if (response.status() >= 400 && route !== '/nope') problems.push(`${name} ${route} ${response.status()}: ${response.url()}`)
      })
      await page.goto(base + route, { waitUntil: 'networkidle' })
      // Lazy images: scroll through so they load before the full-page shot.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y)
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        window.scrollTo(0, 0)
      })
      await page.waitForTimeout(250)
      const overflow = await page.evaluate(
        (width) => Math.max(document.documentElement.scrollWidth, window.innerWidth) - width,
        viewport.width,
      )
      if (overflow > 0) problems.push(`${name} ${route} overflows horizontally by ${overflow}px`)
      const file = (route === '/' ? 'home' : route.slice(1).replace(/\//g, '-')) + `.${name}.png`
      await page.screenshot({ path: path.join(out, file), fullPage: true })
      await page.close()
    }
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}
console.log(problems.length ? problems.join('\n') : 'no console errors, failed requests or overflow')
console.log(`screenshots in ${out}`)
