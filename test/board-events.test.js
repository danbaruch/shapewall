import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createApp, stopChildren } from '../src/server/app.js'
import { createComment, updateComment } from '../src/store.js'
import { request, sampleConfig, tempDir } from './helpers.js'

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

// Opens the board's event stream; `next(name)` resolves with the next event of that name.
function openStream(port, boardId) {
  return new Promise((resolve, reject) => {
    const waiting = []
    const seen = []
    let buffer = ''
    const req = http.get({ host: '127.0.0.1', port, path: `/api/boards/${boardId}/events` }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const name = /^event: (.+)$/m.exec(block)?.[1]
          if (!name) continue
          const at = waiting.findIndex((item) => item.name === name)
          if (at >= 0) waiting.splice(at, 1)[0].resolve({ name, at: Date.now(), block })
          else seen.push({ name, at: Date.now(), block })
        }
      })
      resolve({
        res,
        close: () => req.destroy(),
        next: (name, ms = 3000) => {
          const early = seen.findIndex((item) => item.name === name)
          if (early >= 0) return Promise.resolve(seen.splice(early, 1)[0])
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`no ${name} event in ${ms} ms`)), ms)
            waiting.push({ name, resolve: (value) => (clearTimeout(timer), done(value)) })
          })
        },
        clear: () => seen.splice(0),
      })
    })
    req.on('error', reject)
  })
}

test('the board event stream says "changed" within a second of a comment or capture change made by another process', async () => {
  const config = sampleConfig('board-events')
  const app = createApp({ config, clientDir: tempDir('board-events-client') })
  const server = await listen(app)
  const { port } = server.address()
  try {
    const info = await request(port, 'GET', '/api/info')
    assert.equal(info.json.boardEvents, true)
    assert.equal((await request(port, 'GET', '/api/boards/nope/events')).status, 404)

    // Before anything was captured or commented the board folder does not exist yet.
    const stream = await openStream(port, 'sample')
    assert.match(stream.res.headers['content-type'], /text\/event-stream/)
    await stream.next('ready')

    // A comment, as the CLI or MCP writes it (the store, not this server).
    const board = config.boards[0]
    let started = Date.now()
    const comment = await createComment(config, board, {
      pageId: 'home',
      viewport: 'desktop',
      x: 10,
      y: 10,
      body: 'Make the button green',
      author: 'Sam',
    })
    const first = await stream.next('changed')
    assert.ok(first.at - started < 1000, `${first.at - started} ms`)

    // The agent marks it done.
    stream.clear()
    await new Promise((resolve) => setTimeout(resolve, 300))
    stream.clear()
    started = Date.now()
    await updateComment(config, board.id, comment.id, { agentStatus: 'done' }, { actor: 'agent' })
    const done = await stream.next('changed')
    assert.ok(done.at - started < 1000, `${done.at - started} ms`)

    // A recapture of one page writes into captures/.
    await new Promise((resolve) => setTimeout(resolve, 300))
    stream.clear()
    const captures = path.join(config.outputDir, 'sample', 'captures')
    fs.mkdirSync(captures, { recursive: true })
    await stream.next('changed')
    await new Promise((resolve) => setTimeout(resolve, 300))
    stream.clear()
    started = Date.now()
    fs.writeFileSync(path.join(captures, 'home.desktop.html'), '<!doctype html><p>green</p>')
    const captured = await stream.next('changed')
    assert.ok(captured.at - started < 1000, `${captured.at - started} ms`)
    assert.match(captured.block, /captures\/home\.desktop\.html/)
    stream.close()
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})
