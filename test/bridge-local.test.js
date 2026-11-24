import express from 'express'
import { shareRouter } from '../src/server/share-routes.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server/app.js'
import { writeMigration } from '../src/store.js'
import { request, sampleConfig } from './helpers.js'

test('bridge controls require the direct host capability on reads and same-origin writes', async () => {
  const config = sampleConfig('bridge-host-gate')
  const token = 'host-fixture-capability'
  const app = createApp({ config, settingsToken: token, chat: false, log: () => {} })
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const auth = { 'X-Shapewall-Settings-Token': token }
  try {
    assert.equal((await request(port, 'GET', '/api/share/status')).status, 404)
    assert.equal((await request(port, 'GET', '/api/share/status', { headers: { ...auth, 'X-Forwarded-For': '127.0.0.1' } })).status, 403)
    assert.equal((await request(port, 'GET', '/api/share/status', { headers: auth })).status, 200)
    const body = { board: 'sample', readOnly: false }
    assert.equal((await request(port, 'POST', '/api/share/local-comments', { body, headers: auth })).status, 403)
    assert.equal(
      (await request(port, 'POST', '/API/SHARE/local-comments', { body, headers: { ...auth, Origin: 'http://attacker.example' } })).status,
      403,
    )
    await writeMigration(config, 'sample', { url: 'https://review.example.com/w/example', readOnly: true })
    assert.equal((await request(port, 'POST', '/api/share/local-comments', { body, headers: { ...auth, Origin: origin } })).status, 200)
    assert.equal((await request(port, 'GET', '/api/info', { headers: auth })).json.shareEnabled, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('UI sharing never forwards ambient unscoped project tokens and checks active-fix guard', async () => {
  const config = sampleConfig('bridge-ambient')
  const key = 'owner-capability-fixture'
  const app = express()
  app.use(express.json())
  let captured = null,
    blocked = false
  app.use(
    '/api/share',
    shareRouter({
      config,
      shared: false,
      settingsToken: key,
      env: { SHAPEWALL_TOKEN: 'fixture-must-not-forward', SHAPEWALL_REMOTE: 'https://wrong.example', XDG_CONFIG_HOME: config.dir },
      log: () => {},
      beforeShare: () => {
        if (blocked) throw Error('Active owner fix')
      },
      shareImpl: async (flags, out, options) => {
        captured = options
        return { code: 0, urls: [] }
      },
    }),
  )
  app.use((error, req, res, _next) => res.status(409).json({ error: { message: error.message } }))
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  const port = server.address().port
  const headers = { 'X-Shapewall-Settings-Token': key, Origin: `http://127.0.0.1:${port}` }
  try {
    const result = await request(port, 'POST', '/api/share/start', {
      headers,
      body: { remote: 'https://review.example.com', board: 'sample' },
    })
    assert.equal(result.status, 202)
    assert.equal(captured.env.SHAPEWALL_TOKEN, '')
    assert.equal(captured.env.SHAPEWALL_REMOTE, '')
    assert.equal(captured.env.XDG_CONFIG_HOME, config.dir)
    assert.equal(typeof captured.beforeFreeze, 'function')
    blocked = true
    const refusal = await request(port, 'POST', '/api/share/start', {
      headers,
      body: { remote: 'https://review.example.com', board: 'sample' },
    })
    assert.equal(refusal.status, 409)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
