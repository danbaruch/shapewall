import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp, stopChildren } from '../src/server/app.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const instances = []
after(() => {
  for (const { app, server } of instances) {
    stopChildren(app)
    server.close()
  }
})

async function fixture({ built = true, ...options } = {}) {
  const consoleDir = tempDir('local-console-assets')
  if (built) {
    fs.mkdirSync(path.join(consoleDir, 'assets'))
    fs.writeFileSync(path.join(consoleDir, 'assets', 'console-test.js'), '// console asset')
    fs.writeFileSync(
      path.join(consoleDir, 'console.html'),
      '<head><meta name="sw-nonce" content="__SW_NONCE__"></head><body>Console</body>',
    )
  }
  const app = createApp({ config: sampleConfig('local-console'), consoleDir, env: {}, chat: false, ...options })
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  instances.push({ app, server })
  return server.address().port
}

test('local Console shell and deep links have a fresh style nonce and no hosted session', async () => {
  const port = await fixture()
  const nonces = new Set()
  for (const route of ['/console', '/console/settings', '/_console/console.html']) {
    const result = await request(port, 'GET', route)
    assert.equal(result.status, 200)
    assert.match(result.text, /name="shapewall-local-console"/)
    assert.doesNotMatch(result.text, /__SW_NONCE__/)
    const nonce = /name="sw-nonce" content="([^"]+)"/.exec(result.text)[1]
    nonces.add(nonce)
    assert.ok(result.headers['content-security-policy'].includes(`style-src 'self' 'nonce-${nonce}'`))
    assert.match(result.headers['content-security-policy'], /script-src 'self';/)
    assert.doesNotMatch(result.headers['content-security-policy'], /unsafe-inline|unsafe-eval/)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.headers['x-frame-options'], 'DENY')
    assert.equal(result.headers['set-cookie'], undefined)
  }
  assert.equal(nonces.size, 3)
  const asset = await request(port, 'GET', '/_console/assets/console-test.js')
  assert.equal(asset.text, '// console asset')
  assert.match(asset.headers['cache-control'], /immutable/)
  assert.equal((await request(port, 'GET', '/_console/assets/missing.js')).status, 404)
  assert.equal((await request(port, 'GET', '/console', { headers: { Host: 'attacker.example' } })).status, 421)
  assert.equal((await request(port, 'GET', '/api/workspaces')).status, 404)
})

test('missing local Console build reports unavailable instead of the board or hosted login', async () => {
  const port = await fixture({ built: false })
  const result = await request(port, 'GET', '/console')
  assert.equal(result.status, 503)
  assert.match(result.text, /console is not built/)
})

test('Console never bypasses pairing or grants protected settings and update writes', async () => {
  const envDir = tempDir('local-console-owner')
  const port = await fixture({
    chat: true,
    remote: {},
    settingsToken: 'fixture-owner',
    env: { XDG_CONFIG_HOME: envDir, HOME: envDir, PATH: '' },
  })
  const remoteHeaders = { 'X-Forwarded-For': '192.0.2.5' }
  for (const route of ['/console', '/console/settings', '/_console/console.html', '/_console/assets/console-test.js', '/api/boards']) {
    assert.equal((await request(port, 'GET', route, { headers: remoteHeaders })).status, 401)
  }
  assert.equal((await request(port, 'GET', '/console')).status, 200)
  assert.equal((await request(port, 'GET', '/api/info')).json.agent.settingsEditable, false)
  assert.equal((await request(port, 'GET', '/api/agent/settings')).status, 404)
  assert.equal(
    (await request(port, 'POST', '/api/app-update/apply', { body: {}, headers: { Origin: `http://127.0.0.1:${port}` } })).status,
    403,
  )
})
