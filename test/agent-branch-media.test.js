// Branch mode meets comment media: a fix in an agent worktree still gets the
// comment's images and drawing (as image blocks in the prompt, and as files
// through get_comment), read from the board's own output folder, never from
// the worktree copy (which has no .shapewall store). And the "agents
// changed" event fires when branch mode or batch fixes change, like every
// other agent setting. No model calls: the ACP agent is the fix fixture.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/config.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { boardDir, createComment, getComment } from '../src/store.js'
import { SAMPLE, request, tempDir } from './helpers.js'
import { b64, pngWithText, solidPng } from './comment-media-fixtures.js'

const fixture = path.resolve('test/fixtures/acp-fix.mjs')
const TOKEN = 'branch-media-test-token'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
for (const key of Object.keys(gitEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CEILING)/.test(key)) delete gitEnv[key]
const sh = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  }).trim()

const servers = []
after(async () => {
  for (const { app, server } of servers) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})

async function serve(name, mode) {
  const dir = tempDir(name)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test Person')
  sh(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Original</h1>\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'start')
  const config = loadConfig(path.join(dir, 'shapewall.config.json'))
  const home = tempDir(`${name}-home`)
  const env = { ...process.env, XDG_CONFIG_HOME: home, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(home, 'agents.json') }
  delete env.SHAPEWALL_AGENT_BRANCH_MODE
  delete env.SHAPEWALL_AGENT_ACP
  const app = createApp({
    config,
    env,
    settingsToken: TOKEN,
    agentAcp: `${process.execPath} ${fixture} ${mode}`,
    agentLimits: { burst: 100 },
  })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  servers.push({ app, server })
  const port = server.address().port
  const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': TOKEN }
  return { dir, config, port, headers, home }
}

test('a fix in branch mode gets the comment image and drawing from the board folder', async () => {
  const { config, port, headers } = await serve('branch-media', 'branch-media')
  const captures = path.join(boardDir(config, 'sample'), 'captures')
  fs.mkdirSync(captures, { recursive: true })
  fs.writeFileSync(path.join(captures, 'home.desktop.png'), solidPng(400, 300))
  fs.writeFileSync(
    path.join(captures, 'manifest.json'),
    JSON.stringify({
      capturedAt: '2026-01-01T00:00:00.000Z',
      pages: { home: { desktop: { status: 'ok', version: '20260101T000000000Z-aaaa' } } },
    }),
  )
  const box = {
    tool: 'box',
    ink: 'accent',
    width: 3,
    points: [
      [0.1, 0.1],
      [0.3, 0.2],
    ],
  }
  const comment = await createComment(config, config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 20,
    y: 15,
    body: 'Like this picture, and the box I drew',
    images: [{ name: 'idea.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    drawing: { shapes: [box] },
  })
  assert.equal((await request(port, 'POST', '/api/agent/settings/branch-mode', { headers, body: { enabled: true } })).status, 200)
  const fixed = await request(port, 'POST', `/api/agent/boards/sample/threads/comment-${comment.id}/messages`, {
    headers,
    body: { text: 'Fix it', fix: true },
  })
  assert.equal(fixed.status, 200)
  assert.doesNotMatch(fixed.text, /event: error/, fixed.text.slice(-600))
  assert.match(fixed.text, /Saw [2-9] images and 2 comment files/, 'the agent saw both, as images and as files outside its worktree')
  assert.equal(getComment(config, 'sample', comment.id).agentStatus, 'branch-ready')
})

// GET /api/agent/events, counting "agents" events.
function agentEvents(port) {
  const seen = []
  const req = http.get({ host: '127.0.0.1', port, path: '/api/agent/events' }, (res) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith('event: agents')) seen.push(block)
      }
    })
  })
  req.on('error', () => {})
  return {
    seen,
    async until(count) {
      for (let i = 0; i < 60 && seen.length < count; i++) await wait(50)
      return seen.length
    },
    close: () => req.destroy(),
  }
}

test('turning branch mode or batch fixes on or off tells every open view', async () => {
  const { port, headers } = await serve('branch-events', 'edit')
  const stream = agentEvents(port)
  await wait(100)
  try {
    const post = (pathname, body) => request(port, 'POST', pathname, { headers, body })
    assert.equal((await post('/api/agent/settings/branch-mode', { enabled: true })).status, 200)
    assert.ok((await stream.until(1)) >= 1, 'branch mode on')
    await wait(300)
    const before = stream.seen.length
    assert.equal((await post('/api/agent/settings/branch-mode', { enabled: true, prefix: 'review/' })).status, 200)
    assert.ok((await stream.until(before + 1)) > before, 'branch prefix')
    await wait(300)
    const next = stream.seen.length
    assert.equal((await post('/api/agent/settings/batch-fixes', { enabled: true, max: 4 })).status, 200)
    assert.ok((await stream.until(next + 1)) > next, 'batch fixes')
    // A refused change says nothing.
    await wait(300)
    const settled = stream.seen.length
    assert.equal((await post('/api/agent/settings/batch-fixes', { enabled: 'yes' })).status, 400)
    await wait(400)
    assert.equal(stream.seen.length, settled)
  } finally {
    stream.close()
  }
})
