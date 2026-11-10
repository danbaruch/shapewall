import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { createComment, readMigration, writeMigration } from '../src/store.js'
import { SAMPLE, tempDir, request } from './helpers.js'

test('moving refuses a live owner fix and a moved board refuses new fixes before execution', async () => {
  const dir = tempDir('bridge-active-fix')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const config = loadConfig(file)
  const comment = await createComment(config, config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 20,
    y: 20,
    body: 'Ask permission before changing the fixture',
  })
  const privateDir = path.join(dir, 'private')
  fs.mkdirSync(privateDir, { mode: 0o700 })
  const app = createApp({
    config,
    settingsToken: 'fixture-owner',
    agentAcp: `${process.execPath} ${path.resolve('test/fixtures/acp-stub.mjs')}`,
    env: { ...process.env, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(privateDir, 'agents.json') },
  })
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const headers = { Origin: origin, 'X-Shapewall-Settings-Token': 'fixture-owner' }
  const base = `/api/agent/boards/sample/threads/comment-${comment.id}`
  try {
    const response = await fetch(`${origin}${base}/messages`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'permission', fix: true }),
    })
    assert.equal(response.status, 200)
    const decoder = new TextDecoder()
    let buffer = '',
      checked = false
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const raw = /^data: (.*)$/m.exec(block)?.[1]
        if (!raw) continue
        const card = JSON.parse(raw)
        if (card.kind !== 'permission' || card.state !== 'pending') continue
        assert.equal(app.locals.agentRouter.hasActiveFix('sample'), true)
        const denied = await request(port, 'POST', '/api/share/start', {
          headers,
          body: { board: 'sample', remote: 'http://localhost:9999' },
        })
        assert.equal(denied.status, 409, denied.text)
        assert.equal(denied.json.error.code, 'active_agent_fix')
        assert.equal(readMigration(config, 'sample'), null)
        const approved = await request(port, 'POST', `${base}/permissions/${card.id}`, {
          headers,
          body: { optionId: 'allow' },
        })
        assert.equal(approved.status, 200)
        checked = true
      }
    }
    assert.equal(checked, true, 'the real ACP fixture reached its permission boundary')
    assert.equal(app.locals.agentRouter.hasActiveFix('sample'), false)
    await writeMigration(config, 'sample', { url: 'https://review.example.test/board', readOnly: true })
    const refused = await request(port, 'POST', `${base}/messages`, {
      headers,
      body: { text: 'permission', fix: true },
    })
    assert.equal(refused.status, 403)
    assert.equal(refused.json.error.code, 'comments_moved')
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})
