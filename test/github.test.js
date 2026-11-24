// GitHub connect against a stub GitHub API on 127.0.0.1: no real GitHub
// calls. Covers the config, issue text, issues, manual and found links,
// merges resolving comments, sync, the webhook, the API, MCP, the CLI and
// doctor.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { normalizeConfig } from '../src/config.js'
import { feedbackContext, feedbackItem } from '../src/feedback.js'
import {
  checkGithub,
  createIssue,
  githubSettings,
  issueContent,
  linkPull,
  parsePullRef,
  refsInText,
  syncGithub,
  syncStateFile,
  verifySignature,
} from '../src/github.js'
import { createMcpServer } from '../src/mcp.js'
import { createApp } from '../src/server/app.js'
import { createComment, getComment, listComments, updateComment } from '../src/store.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shapewall.js')
const TOKEN = 'ghp_test_not_a_real_token_123'
const SECRET = 'webhook-test-secret'

// ---- The stub GitHub ---------------------------------------------------------------

const stub = { requests: [], pulls: new Map(), nextIssue: 45, delayMs: 0 }
let stubServer
let apiUrl

function pr(number, { body = '', title = `PR ${number}`, state = 'open', merged = false, updatedAt = '2026-11-04T10:00:00Z' } = {}) {
  return {
    number,
    html_url: `https://github.com/acme/site/pull/${number}`,
    title,
    body,
    state: merged ? 'closed' : state,
    merged_at: merged ? '2026-11-04T11:00:00Z' : null,
    updated_at: updatedAt,
  }
}

before(async () => {
  stubServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      const url = new URL(req.url, 'http://stub')
      stub.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body })
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' })
      if (stub.delayMs) await new Promise((resolve) => setTimeout(resolve, stub.delayMs))
      if (req.method === 'GET' && url.pathname === '/repos/acme/site') return send(200, { full_name: 'acme/site', has_issues: true })
      if (req.method === 'POST' && url.pathname === '/repos/acme/site/issues') {
        const number = stub.nextIssue
        stub.nextIssue += 1
        return send(201, { number, html_url: `https://github.com/acme/site/issues/${number}`, title: body.title })
      }
      if (req.method === 'GET' && url.pathname === '/repos/acme/site/pulls') {
        const page = Number(url.searchParams.get('page') || 1)
        const list = [...stub.pulls.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        return send(200, page === 1 ? list : [])
      }
      const match = /^\/repos\/acme\/site\/pulls\/(\d+)$/.exec(url.pathname)
      if (req.method === 'GET' && match) {
        const found = stub.pulls.get(Number(match[1]))
        return found ? send(200, found) : send(404, { message: 'Not Found' })
      }
      send(404, { message: 'Not Found' })
    })
  })
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${stubServer.address().port}`
})

after(() => stubServer?.close())

const envFor = (extra = {}) => ({ SHAPEWALL_GITHUB_API_URL: apiUrl, GITHUB_TOKEN: TOKEN, ...extra })

function githubConfig(name, github = {}) {
  const dir = tempDir(name)
  const raw = { ...structuredClone(SAMPLE), github: { repo: 'acme/site', boardUrl: 'http://board.test/review/', ...github } }
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(raw))
  return normalizeConfig(raw, { dir, file: path.join(dir, 'shapewall.config.json') })
}

const pricingComment = (config, body = 'Make the Plus button pop, @robin agrees') =>
  createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 27.05,
    body,
    author: 'Robin',
    anchor: { selector: 'a[data-testid="plus-cta"]', text: 'Try Plus free', dx: 0.5, dy: 0.5 },
  })

// ---- Config and settings -----------------------------------------------------------

test('config: github takes a repo and URLs; secrets in the file are refused', () => {
  const config = githubConfig('gh-config', { labels: ['feedback'] })
  assert.deepEqual(config.github, {
    repo: 'acme/site',
    boardUrl: 'http://board.test/review/',
    apiUrl: null,
    labels: ['feedback'],
    board: null,
  })
  assert.equal(normalizeConfig(structuredClone(SAMPLE)).github, null)
  assert.throws(
    () => normalizeConfig({ ...structuredClone(SAMPLE), github: { repo: 'acme/site', token: 'x' } }),
    /github\.token: never put secrets in the config/,
  )
  assert.throws(() => normalizeConfig({ ...structuredClone(SAMPLE), github: { repo: 'not a repo' } }), /github\.repo: "owner\/name"/)
  assert.throws(() => normalizeConfig({ ...structuredClone(SAMPLE), github: { board: 'nope' } }), /github\.board: no board "nope"/)
})

test('settings: token from the environment, never in the settings; https or loopback only', () => {
  const config = githubConfig('gh-settings')
  const settings = githubSettings(config, envFor())
  assert.equal(settings.ready, true)
  assert.equal(settings.tokenVar, 'GITHUB_TOKEN')
  assert.ok(!JSON.stringify(settings).includes(TOKEN))
  assert.equal(githubSettings(config, envFor({ SHAPEWALL_GITHUB_TOKEN: 'other' })).tokenVar, 'SHAPEWALL_GITHUB_TOKEN')
  assert.equal(githubSettings(config, {}).ready, false)
  const plain = githubSettings(config, envFor({ SHAPEWALL_GITHUB_API_URL: 'http://github.example.com/api' }))
  assert.equal(plain.ready, false)
  assert.match(plain.apiError, /must be https/)
  assert.equal(githubSettings(config, envFor({ SHAPEWALL_GITHUB_REPO: 'other/repo' })).repo, 'other/repo')
})

test('refs: markers, board-scoped markers and closed issues are found in PR text', () => {
  assert.deepEqual(refsInText('Bolder button.\n\nshapewall:12, Fixes shapewall#3 and shapewall:docs/7. Closes #45', 'sample'), {
    comments: [
      { boardId: 'sample', commentId: 12 },
      { boardId: 'sample', commentId: 3 },
      { boardId: 'docs', commentId: 7 },
    ],
    issues: [45],
  })
  assert.deepEqual(refsInText('no markers, see #45 and shapewall:0', 'sample'), { comments: [], issues: [] })
  assert.equal(parsePullRef('#12', 'acme/site'), 12)
  assert.equal(parsePullRef('https://github.com/acme/site/pull/9/files', 'acme/site'), 9)
  assert.throws(() => parsePullRef('https://github.com/evil/site/pull/9', 'acme/site'), /in evil\/site, not acme\/site/)
  assert.throws(() => parsePullRef('main', 'acme/site'), /pull request number/)
})

test('issue text: quoted comment, page, element, pin, screenshot link and crop, board link, marker', async () => {
  const config = githubConfig('gh-text')
  const comment = await pricingComment(config, 'Make the Plus button pop\n@robin agrees')
  const board = config.boards[0]
  const item = feedbackItem(feedbackContext(config, board), comment)
  const { title, body } = issueContent(githubSettings(config, envFor()), board.id, item)
  assert.equal(title, 'Pricing: Make the Plus button pop')
  assert.match(body, /^> Make the Plus button pop\n> @\u200brobin agrees/)
  assert.match(body, /\*\*Page:\*\* \[Pricing\]\(http:\/\/127\.0\.0\.1:9\/pricing\) \(`\/pricing`\), desktop 1440x2200/)
  assert.match(body, /\*\*Element:\*\* `a\[data-testid="plus-cta"\]` \("Try Plus free"\)/)
  assert.match(body, /\*\*Pin:\*\* 720, 595 px \(50% \/ 27\.05%\)/)
  assert.match(body, /x 270-1170, y 245-945/)
  assert.match(body, /not captured/)
  assert.match(body, /\[comment #1\]\(http:\/\/board\.test\/review\/\?board=sample&filter=all&c=1\)/)
  assert.match(body, /<!-- shapewall:sample\/1 -->/)
  assert.ok(!body.includes('\u2014'))
})

// ---- Issues and links ----------------------------------------------------------------

test('createIssue opens one issue, stores it on the comment and never again for the same comment', async () => {
  const config = githubConfig('gh-issue', { labels: ['feedback'] })
  const comment = await pricingComment(config)
  stub.requests.length = 0
  stub.delayMs = 50
  const [first, second] = await Promise.all([
    createIssue(config, { commentId: comment.id, env: envFor() }),
    createIssue(config, { commentId: comment.id, env: envFor() }),
  ])
  stub.delayMs = 0
  const posts = stub.requests.filter((item) => item.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(posts[0].headers['x-github-api-version'], '2022-11-28')
  assert.deepEqual(posts[0].body.labels, ['feedback'])
  assert.equal(first.created, true)
  assert.equal(second.issue.number, first.issue.number)
  const stored = getComment(config, 'sample', comment.id)
  assert.equal(stored.github.issue.url, `https://github.com/acme/site/issues/${first.issue.number}`)
  const again = await createIssue(config, { commentId: comment.id, env: envFor() })
  assert.equal(again.created, false)
  assert.equal(stub.requests.filter((item) => item.method === 'POST').length, 1)
  // Not set up: a clear message, and nothing leaves.
  const other = await pricingComment(config, 'Another')
  await assert.rejects(createIssue(config, { commentId: other.id, env: {} }), /No GitHub token: set SHAPEWALL_GITHUB_TOKEN or GITHUB_TOKEN/)
  await assert.rejects(
    createIssue(config, { commentId: other.id, env: envFor({ GITHUB_TOKEN: 'wrong' }) }),
    (error) => /refused the token in GITHUB_TOKEN/.test(error.message) && !error.message.includes('wrong'),
  )
})

test('a merged pull request resolves its comment once, with a reply and the PR as the fix; before/after stays', async () => {
  const config = githubConfig('gh-link')
  const comment = await pricingComment(config)
  stub.pulls.set(12, pr(12, { title: 'Bolder Plus button' }))
  const linked = await linkPull(config, { commentId: comment.id, pr: '#12', env: envFor() })
  assert.equal(linked.merged, false)
  assert.deepEqual([linked.pull.number, linked.pull.state, linked.pull.via, linked.comment.status], [12, 'open', 'manual', 'open'])
  stub.pulls.set(12, pr(12, { title: 'Bolder Plus button', merged: true, updatedAt: '2026-11-04T11:00:00Z' }))
  const result = await syncGithub(config, { env: envFor(), now: new Date('2026-11-04T12:00:00Z') })
  assert.deepEqual(result.merged, [{ board: 'sample', comment: comment.id, pull: 12, state: 'merged' }])
  const resolved = getComment(config, 'sample', comment.id)
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.fixRef, 'https://github.com/acme/site/pull/12')
  assert.equal(resolved.resolution, 'Merged in pull request #12 (Bolder Plus button).')
  assert.equal(resolved.captureVersion, comment.captureVersion)
  assert.deepEqual(
    resolved.replies.map((reply) => [reply.author, reply.body]),
    [['github', 'Merged pull request #12 (Bolder Plus button): https://github.com/acme/site/pull/12']],
  )
  // Reopened by a person: a later sync does not resolve it again.
  await updateComment(config, 'sample', comment.id, { status: 'open' })
  await syncGithub(config, { env: envFor(), now: new Date('2026-11-04T13:00:00Z') })
  const reopened = getComment(config, 'sample', comment.id)
  assert.equal(reopened.status, 'open')
  assert.equal(reopened.replies.length, 1)
  stub.pulls.clear()
})

test('sync finds markers and closed issues, skips unknown comments and remembers where it stopped', async () => {
  const config = githubConfig('gh-sync')
  const one = await pricingComment(config, 'One')
  const two = await pricingComment(config, 'Two')
  const three = await pricingComment(config, 'Three')
  const issue = await createIssue(config, { commentId: three.id, env: envFor() })
  stub.pulls.set(20, pr(20, { body: `Tighter spacing.\n\nshapewall:${one.id}`, updatedAt: '2026-11-04T09:00:00Z' }))
  stub.pulls.set(21, pr(21, { body: `Fixes shapewall#${two.id}`, merged: true, updatedAt: '2026-11-04T09:30:00Z' }))
  stub.pulls.set(22, pr(22, { body: `Fixes #${issue.issue.number}`, updatedAt: '2026-11-04T09:40:00Z' }))
  stub.pulls.set(23, pr(23, { body: 'shapewall:999 and shapewall:nope/1', updatedAt: '2026-11-04T08:00:00Z' }))
  const first = await syncGithub(config, { env: envFor(), now: new Date('2026-11-04T10:00:00Z') })
  assert.equal(first.scanned, 4)
  assert.deepEqual(first.linked.map((item) => [item.pull, item.comment]).sort(), [
    [20, one.id],
    [21, two.id],
    [22, three.id],
  ])
  assert.deepEqual(
    first.skipped.map((item) => [item.board, item.comment, item.reason]),
    [
      ['sample', 999, 'no such comment'],
      ['nope', 1, 'no such board'],
    ],
  )
  const comments = Object.fromEntries(listComments(config, 'sample').map((item) => [item.id, item]))
  assert.equal(comments[one.id].github.pulls[0].via, 'body')
  assert.equal(comments[one.id].status, 'open')
  assert.equal(comments[two.id].status, 'resolved')
  assert.equal(comments[three.id].github.pulls[0].via, 'issue')
  assert.equal(JSON.parse(fs.readFileSync(syncStateFile(config), 'utf8')).lastSyncAt, '2026-11-04T10:00:00.000Z')
  // Next time: only what changed since (minus a little overlap), plus open linked PRs it did not see.
  stub.pulls.set(20, pr(20, { body: `shapewall:${one.id}`, merged: true, updatedAt: '2026-11-04T10:30:00Z' }))
  stub.requests.length = 0
  const second = await syncGithub(config, { env: envFor(), now: new Date('2026-11-04T11:00:00Z') })
  assert.deepEqual(
    second.merged.map((item) => item.pull),
    [20],
  )
  assert.equal(getComment(config, 'sample', one.id).status, 'resolved')
  assert.ok(stub.requests.some((item) => item.path === '/repos/acme/site/pulls/22'))
  stub.pulls.clear()
})

test('a merge emits comment.resolved and comment.replied for notifications, once', async () => {
  const { onCommentEvent } = await import('../src/events.js')
  const config = githubConfig('gh-events')
  const comment = await pricingComment(config)
  const types = []
  const stop = onCommentEvent((event) => event.commentId === comment.id && types.push(event.type))
  try {
    const { recordGithubPull } = await import('../src/store.js')
    const merged = { number: 70, url: 'https://github.com/acme/site/pull/70', title: 'Fix', state: 'merged' }
    await recordGithubPull(config, 'sample', comment.id, merged, { via: 'body' })
    await recordGithubPull(config, 'sample', comment.id, merged, { via: 'body' })
    assert.deepEqual(types.sort(), ['comment.replied', 'comment.resolved'])
  } finally {
    stop()
  }
})

// ---- Webhook and API -------------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

const sign = (body) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`

test('webhook: off without a secret, refuses bad signatures, links and resolves on a merged PR event', async () => {
  const config = githubConfig('gh-webhook')
  const comment = await pricingComment(config)
  const clientDir = tempDir('gh-client')
  const off = await listen(createApp({ config, clientDir, env: {} }))
  const on = await listen(createApp({ config, clientDir, env: { [`SHAPEWALL_GITHUB_WEBHOOK_SECRET`]: SECRET } }))
  try {
    const event = (action, pull, repo = 'acme/site') => JSON.stringify({ action, repository: { full_name: repo }, pull_request: pull })
    const post = (port, body, headers) => request(port, 'POST', '/api/github/webhook', { body, headers })
    const opened = event('opened', pr(30, { body: `shapewall:${comment.id}` }))
    const headers = (body, name = 'pull_request') => ({
      'Content-Type': 'application/json',
      'X-GitHub-Event': name,
      'X-Hub-Signature-256': sign(body),
    })
    assert.equal((await post(off.address().port, opened, headers(opened))).status, 404)
    const port = on.address().port
    assert.equal((await post(port, opened, { ...headers(opened), 'X-Hub-Signature-256': 'sha256=00' })).status, 401)
    assert.equal((await post(port, opened, { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request' })).status, 401)
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' })
    assert.equal((await post(port, ping, headers(ping, 'ping'))).json.pong, true)
    const elsewhere = event('opened', pr(31, { body: `shapewall:${comment.id}` }), 'evil/site')
    assert.equal((await post(port, elsewhere, headers(elsewhere))).json.ignored, 'another repository')
    const linked = await post(port, opened, headers(opened))
    assert.equal(linked.status, 200)
    assert.deepEqual(linked.json.linked, [{ board: 'sample', comment: comment.id, pull: 30, state: 'open' }])
    // Merged later; the description no longer needs the marker, the link is known.
    const merged = event('closed', pr(30, { merged: true }))
    const done = await post(port, merged, headers(merged))
    assert.deepEqual(done.json.merged, [{ board: 'sample', comment: comment.id, pull: 30, state: 'merged' }])
    assert.equal(getComment(config, 'sample', comment.id).status, 'resolved')
    // Form-encoded deliveries work too; the same event again changes nothing.
    const form = `payload=${encodeURIComponent(merged)}`
    const again = await post(port, form, { ...headers(form), 'Content-Type': 'application/x-www-form-urlencoded' })
    assert.deepEqual([again.status, again.json.merged, again.json.linked], [200, [], []])
    assert.equal(getComment(config, 'sample', comment.id).replies.length, 1)
  } finally {
    off.close()
    on.close()
  }
})

test('verifySignature compares in constant time and needs the sha256= form', () => {
  const body = Buffer.from('{"a":1}')
  assert.equal(verifySignature(SECRET, body, sign(body)), true)
  assert.equal(verifySignature(SECRET, body, sign(body).replace('sha256=', 'sha1=')), false)
  assert.equal(verifySignature('', body, sign(body)), false)
  assert.equal(verifySignature(SECRET, Buffer.from('{"a":2}'), sign(body)), false)
})

test('API: info says whether GitHub is ready (never the token); the board makes issues and links PRs', async () => {
  const config = githubConfig('gh-api')
  const comment = await pricingComment(config)
  const clientDir = tempDir('gh-api-client')
  const server = await listen(createApp({ config, clientDir, env: envFor() }))
  const readOnly = await listen(createApp({ config, clientDir, env: envFor(), readOnly: true }))
  const bare = await listen(createApp({ config, clientDir, env: {} }))
  try {
    const port = server.address().port
    const info = await request(port, 'GET', '/api/info')
    assert.deepEqual(info.json.github, { repo: 'acme/site', ready: true })
    assert.ok(!info.text.includes(TOKEN))
    assert.deepEqual((await request(bare.address().port, 'GET', '/api/info')).json.github, { repo: 'acme/site', ready: false })
    const made = await request(port, 'POST', `/api/boards/sample/comments/${comment.id}/github/issue`, { body: {} })
    assert.equal(made.status, 201)
    assert.equal(made.json.comment.github.issue.number, made.json.issue.number)
    assert.equal((await request(port, 'POST', `/api/boards/sample/comments/${comment.id}/github/issue`, { body: {} })).status, 200)
    const listed = await request(port, 'GET', '/api/boards/sample/comments')
    assert.equal(listed.json.comments[0].github.issue.url, made.json.issue.url)
    stub.pulls.set(40, pr(40))
    const link = await request(port, 'POST', `/api/boards/sample/comments/${comment.id}/github/link`, { body: { pr: 40 } })
    assert.deepEqual([link.status, link.json.pull.number, link.json.merged], [200, 40, false])
    const missing = await request(port, 'POST', `/api/boards/sample/comments/${comment.id}/github/link`, { body: { pr: 41 } })
    assert.equal(missing.status, 404)
    const noToken = await request(bare.address().port, 'POST', `/api/boards/sample/comments/${comment.id}/github/link`, {
      body: { pr: 40 },
    })
    assert.deepEqual([noToken.status, noToken.json.error.code], [400, 'github_not_configured'])
    const blocked = await request(readOnly.address().port, 'POST', `/api/boards/sample/comments/${comment.id}/github/issue`, { body: {} })
    assert.equal(blocked.status, 403)
  } finally {
    server.close()
    readOnly.close()
    bare.close()
    stub.pulls.clear()
  }
})

// ---- MCP, CLI, doctor --------------------------------------------------------------------

test('MCP: GitHub tools appear when a repo is set and make issues and links', async () => {
  const config = githubConfig('gh-mcp')
  const comment = await pricingComment(config)
  const connect = async (options) => {
    const server = createMcpServer({ config, env: envFor(), ...options })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'shapewall-test', version: '1.0.0' })
    await client.connect(clientSide)
    return client
  }
  const client = await connect({})
  const readOnly = await connect({ readOnly: true })
  try {
    const names = (await client.listTools()).tools.map((item) => item.name)
    assert.ok(names.includes('create_github_issue') && names.includes('link_pull_request'))
    assert.ok(!(await readOnly.listTools()).tools.some((item) => item.name.includes('github') || item.name === 'link_pull_request'))
    const issue = JSON.parse((await client.callTool({ name: 'create_github_issue', arguments: { id: comment.id } })).content[0].text)
    assert.equal(issue.created, true)
    stub.pulls.set(50, pr(50, { merged: true }))
    const link = JSON.parse(
      (await client.callTool({ name: 'link_pull_request', arguments: { id: comment.id, pr: 'https://github.com/acme/site/pull/50' } }))
        .content[0].text,
    )
    assert.deepEqual([link.merged, link.status], [true, 'resolved'])
    const bad = await client.callTool({ name: 'link_pull_request', arguments: { id: comment.id, pr: 'nope' } })
    assert.equal(bad.isError, true)
  } finally {
    await client.close()
    await readOnly.close()
    stub.pulls.clear()
  }
})

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    )
  })
}

test('CLI: github issue, link and sync; the token never shows in the output', async () => {
  const config = githubConfig('gh-cli')
  const comment = await pricingComment(config)
  const file = config.file
  const issue = await run(['github', 'issue', String(comment.id), '--config', file], envFor())
  assert.equal(issue.code, 0, issue.stderr)
  assert.match(issue.stdout, /Opened issue #\d+ for comment #1: https:\/\/github\.com\/acme\/site\/issues\/\d+/)
  stub.pulls.set(60, pr(60))
  const link = await run(['github', 'link', String(comment.id), '60', '--config', file, '--json'], envFor())
  assert.equal(JSON.parse(link.stdout).pull.number, 60)
  stub.pulls.set(61, pr(61, { body: 'shapewall:1', merged: true }))
  const sync = await run(['github', 'sync', '--config', file], envFor())
  assert.match(sync.stdout, /Read 2 pull requests of acme\/site/)
  assert.match(sync.stdout, /resolved comment sample\/1 \(pull request #61 merged\)/)
  const noToken = await run(['github', 'sync', '--config', file], { SHAPEWALL_GITHUB_API_URL: apiUrl })
  assert.equal(noToken.code, 1)
  assert.match(noToken.stderr, /No GitHub token/)
  for (const output of [issue, link, sync]) assert.ok(!`${output.stdout}${output.stderr}`.includes(TOKEN))
  stub.pulls.clear()
})

test('doctor: GitHub off, missing token, working token and a refused token', async () => {
  const config = githubConfig('gh-doctor')
  assert.equal((await checkGithub(normalizeConfig(structuredClone(SAMPLE)), { env: {} })).status, 'skip')
  const missing = await checkGithub(config, { env: {} })
  assert.equal(missing.status, 'warn')
  assert.match(missing.fix, /SHAPEWALL_GITHUB_TOKEN or GITHUB_TOKEN/)
  const ok = await checkGithub(config, { env: envFor() })
  assert.equal(ok.status, 'ok')
  assert.match(ok.message, /GitHub acme\/site, token from GITHUB_TOKEN, no webhook secret.*the token can see the repo/)
  const refused = await checkGithub(config, { env: envFor({ GITHUB_TOKEN: 'wrong' }) })
  // A rejected token breaks every GitHub action, so it is a FAIL.
  assert.equal(refused.status, 'fail')
  assert.match(refused.message, /refused the token/)
  assert.match(refused.fix, /Replace the token in GITHUB_TOKEN/)
})

test('without a token variable, a signed-in gh CLI lends its token, for github.com only', () => {
  const config = githubConfig('gh-cli')
  const bin = tempDir('gh-cli-bin')
  const gh = path.join(bin, 'gh')
  fs.writeFileSync(gh, '#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && echo gho_fromthecli_1234567890\n')
  fs.chmodSync(gh, 0o755)
  const env = { PATH: bin, HOME: bin }
  const settings = githubSettings(config, env)
  assert.equal(settings.tokenVar, 'gh auth token')
  assert.equal(settings.ready, true)
  assert.ok(!JSON.stringify(settings).includes('gho_fromthecli'), 'the token never appears in the settings')
  // Another API URL (a stub, GitHub Enterprise) never gets the github.com token.
  assert.equal(githubSettings(config, { ...env, SHAPEWALL_GITHUB_API_URL: 'http://127.0.0.1:9/' }).tokenVar, null)
  // A token variable wins; SHAPEWALL_GITHUB_GH=0 turns the CLI off.
  assert.equal(githubSettings(config, { ...env, GITHUB_TOKEN: 'x' }).tokenVar, 'GITHUB_TOKEN')
  assert.equal(githubSettings(config, { ...env, SHAPEWALL_GITHUB_GH: '0' }).tokenVar, null)
  // No gh on PATH, or gh signed out: no token.
  assert.equal(githubSettings(config, { PATH: tempDir('gh-cli-empty') }).tokenVar, null)
})

test('a config-only apiUrl never receives an environment token', () => {
  const config = { boards: [{ id: 'main' }], github: { repo: 'acme/site', apiUrl: 'https://ghe.example.com/api/v3' } }
  const fromConfig = githubSettings(config, { GITHUB_TOKEN: 'ghp_example' })
  assert.equal(fromConfig.tokenVar, null)
  assert.equal(fromConfig.ready, false)
  const confirmed = githubSettings(config, { GITHUB_TOKEN: 'ghp_example', SHAPEWALL_GITHUB_API_URL: 'https://ghe.example.com/api/v3' })
  assert.equal(confirmed.tokenVar, 'GITHUB_TOKEN')
  assert.equal(confirmed.ready, true)
})

test('doctor says how to confirm a config-only apiUrl instead of asking for a token', async () => {
  const { checkGithub } = await import('../src/github.js')
  const config = { boards: [{ id: 'main' }], github: { repo: 'acme/site', apiUrl: 'https://ghe.example.com/api/v3' } }
  const check = await checkGithub(config, { env: { GITHUB_TOKEN: 'ghp_example' }, network: false })
  assert.equal(check.status, 'fail')
  assert.match(check.fix, /SHAPEWALL_GITHUB_API_URL=https:\/\/ghe\.example\.com\/api\/v3/)
})
