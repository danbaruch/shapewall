import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { REDIRECTS } from '../src/routes.js'
import { createServer } from '../scripts/serve.mjs'

let server, origin
before(async () => {
  server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('retired Roadmap URLs permanently redirect to Features without losing queries', async () => {
  const caddy = fs.readFileSync(new URL('../deploy/shapewall.Caddyfile', import.meta.url), 'utf8')
  assert.match(caddy, /@retiredRoadmap path \/roadmap \/roadmap\/ \/roadmap\.html/)
  assert.match(caddy, /redir @retiredRoadmap \/features\{\?query\} permanent/)
  for (const [from, to] of Object.entries(REDIRECTS)) {
    for (const query of ['', '?source=old-link&view=all']) {
      const response = await fetch(origin + from + query, { redirect: 'manual' })
      assert.equal(response.status, 301, from + query)
      assert.equal(response.headers.get('location'), to + query)
    }
  }
})
