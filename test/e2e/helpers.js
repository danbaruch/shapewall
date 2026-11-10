import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { normalizeConfig } from '../../src/config.js'
import { matchSelector } from '../../src/capture/element-map.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Starts the demo site on a free port and returns a config for it whose
// output goes to test/.output/<name> (on disk, ignored by git).
// `configFile`: shapewall.config.json (7 pages) or shapewall.full.config.json.
export async function demoSetup(name, { configFile = 'shapewall.config.json' } = {}) {
  const site = await startDemoSite({ port: 0 })
  const port = site.address().port
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'demo-site', configFile), 'utf8'))
  const dir = path.join(ROOT, 'test', '.output', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  raw.baseUrl = `http://127.0.0.1:${port}`
  raw.outputDir = path.join(dir, '.shapewall')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  const config = normalizeConfig(raw, { dir, file })
  return { config, dir, site, close: () => new Promise((resolve) => site.close(resolve)) }
}

export function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
}

export const ROOT_DIR = ROOT

// The URL of a live frame's element map, from the frame's own src: the
// board API (live -> elements), or a static export's file beside the HTML.
export function elementMapUrl(liveSrc) {
  const [pathname, query = ''] = String(liveSrc).split('?')
  const mapped = pathname
    .replace(/\/variant-live\/([^/]+)\.html$/, '/variant-elements/$1.elements.json')
    .replace(/\/live\/([^/]+)\.html$/, '/elements/$1.elements.json')
    .replace(/\.html$/, '.elements.json')
  return query ? `${mapped}?${query}` : mapped
}

// Screen box of an element in a live frame, from its element map: the frame
// has an opaque origin, so neither the board nor a test can read its DOM.
// `selector` is an anchor-grammar selector, or a bare tag name (its first).
export async function liveElementBox(page, frameSelector, selector) {
  const src = await page.getAttribute(`${frameSelector} iframe`, 'src')
  const map = await page.evaluate(async (url) => (await fetch(url, { cache: 'no-store' })).json(), elementMapUrl(src))
  const index = /^[a-z][a-z0-9-]*$/.test(selector) ? map.elements.findIndex((item) => item.t === selector) : matchSelector(map, selector)
  if (index < 0) throw new Error(`no ${selector} in the element map of ${src}`)
  const [left, top, width, height] = map.elements[index].b
  return page.evaluate(
    ([frameSel, box]) => {
      const frame = document.querySelector(frameSel)
      const iframe = frame.querySelector('iframe')
      const outer = frame.getBoundingClientRect()
      const scale = outer.width / iframe.offsetWidth
      return {
        left: outer.left + box.left * scale,
        top: outer.top + box.top * scale,
        right: outer.left + (box.left + box.width) * scale,
        bottom: outer.top + (box.top + box.height) * scale,
        x: outer.left + (box.left + box.width / 2) * scale,
        y: outer.top + (box.top + box.height / 2) * scale,
      }
    },
    [frameSelector, { left, top, width, height }],
  )
}

// Observe actual stream delivery and DOM updates independently: a test can
// prove text arrived while only thinking/tool cards were shown to the reader.
export async function observeChatReply(page) {
  await page.evaluate(() => {
    window.__chatEvents = []
    window.__chatRenders = []
    const fetch = window.fetch
    window.fetch = async (...args) => {
      const response = await fetch(...args)
      if (!String(args[0]).endsWith('/messages') || !response.headers.get('content-type')?.includes('text/event-stream')) return response
      let buffer = ''
      const decoder = new TextDecoder()
      const stream = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true })
            let end
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              const event = /^event: (.*)$/m.exec(block)?.[1]
              const raw = /^data: (.*)$/m.exec(block)?.[1]
              if (event && raw) window.__chatEvents.push({ event, data: JSON.parse(raw) })
            }
            controller.enqueue(chunk)
          },
        }),
      )
      return new Response(stream, { status: response.status, headers: response.headers })
    }
    new MutationObserver(() => {
      const last = [...document.querySelectorAll('[data-sw-chat-message]')].at(-1)
      if (last?.dataset.swChatMessage !== 'assistant') return
      window.__chatRenders.push({
        status: last.dataset.status,
        text: last.querySelector('[data-sw-markdown]')?.textContent || '',
        reasoning: Boolean(last.querySelector('[data-sw-chat-reasoning]')),
        read: Boolean(last.querySelector('[data-sw-chat-speak]')),
      })
    }).observe(document.querySelector('[data-sw-chat-list]'), { subtree: true, childList: true, characterData: true, attributes: true })
  })
}
