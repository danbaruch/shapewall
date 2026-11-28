// 2.0.0 (plan R5d): `shapewall github` on the solo engine. With no engine
// running (the database a migration made), `issue`, `link` and `sync` start
// it for themselves, ask a stand-in for the GitHub API (never the real one),
// record the links through the engine's token API (migration 25), and stop
// it again. A merged pull request resolves its comment once, with a reply
// from "github", as on a 1.x board. The GitHub token goes to GitHub only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { boardHome } from '../src/cli/board-home.js'
import { autoMigrate } from '../src/cli/serve-command.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createComment } from '../src/store.js'
import { engineTarget } from '../src/engine-target.js'
import { SAMPLE, isolatedEnv, tempDir } from './helpers.js'

quietSqliteWarning()
const ENV = isolatedEnv('github-engine-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })
const GH_TOKEN = 'gh-test-token-for-the-stand-in-only'
const MERGED_AT = '2026-11-20T10:00:00.000Z'

// The GitHub API, as much of it as the commands use. Records every request.
function standIn() {
  const requests = []
  const pulls = {
    5: {
      number: 5,
      html_url: 'https://github.com/acme/site/pull/5',
      title: 'Bigger logo',
      state: 'closed',
      merged_at: MERGED_AT,
      body: '',
    },
    6: {
      number: 6,
      html_url: 'https://github.com/acme/site/pull/6',
      title: 'Pricing copy',
      state: 'open',
      merged_at: null,
      body: 'Works on shapewall:2',
      updated_at: '2026-11-21T10:00:00.000Z',
    },
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: raw ? JSON.parse(raw) : null })
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && req.url === '/repos/acme/site/issues')
        return send(201, { number: 41, html_url: 'https://github.com/acme/site/issues/41', title: JSON.parse(raw).title })
      const one = /^\/repos\/acme\/site\/pulls\/(\d+)$/.exec(req.url)
      if (req.method === 'GET' && one && pulls[one[1]]) return send(200, { ...pulls[one[1]], updated_at: MERGED_AT })
      if (req.method === 'GET' && req.url.startsWith('/repos/acme/site/pulls?'))
        return send(200, [pulls[6], { ...pulls[5], updated_at: MERGED_AT }])
      send(404, { message: 'Not Found' })
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })),
  )
}

async function migratedProject(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'GitHub Notes', github: { repo: 'acme/site' } }, null, 2))
  const config = loadConfig(file)
  const board = config.boards[0]
  for (const [pageId, body] of [
    ['home', 'Bigger logo'],
    ['pricing', 'Clearer prices'],
  ])
    await createComment(config, board, { pageId, viewport: 'desktop', x: 10, y: 10, body, author: 'Robin' })
  const lines = []
  assert.equal((await autoMigrate(config, (line) => lines.push(line), { env: ENV })).migrated, true, lines.join('\n'))
  return { config, file, home: (await boardHome(config, { env: ENV })).config }
}

async function cli(argv) {
  const lines = []
  const errs = []
  try {
    const code = await main(argv, { out: (line) => lines.push(String(line)), err: (line) => errs.push(String(line)) })
    return { code: code ?? 0, out: lines.join('\n'), err: errs.join('\n') }
  } catch (error) {
    return { code: 1, out: lines.join('\n'), err: `${errs.join('\n')}\n${error.message}` }
  }
}

// The GitHub settings for these commands only (main() reads process.env), put back after.
async function withGithub(url, work) {
  const names = ['SHAPEWALL_GITHUB_TOKEN', 'SHAPEWALL_GITHUB_API_URL', 'SHAPEWALL_GITHUB_REPO', 'SHAPEWALL_BOARD_URL']
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.SHAPEWALL_GITHUB_TOKEN = GH_TOKEN
  process.env.SHAPEWALL_GITHUB_API_URL = url
  delete process.env.SHAPEWALL_GITHUB_REPO
  delete process.env.SHAPEWALL_BOARD_URL
  try {
    return await work()
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

test('github issue, link and sync on the solo engine: links kept on its comments, a merge resolves once, the engine stops after', async (t) => {
  const { config, file, home } = await migratedProject('github-engine')
  const gh = await standIn()
  t.after(() => gh.server.close())
  await withGithub(gh.url, async () => {
    // An issue from comment 1: made on GitHub, kept on the engine.
    const issue = await cli(['github', 'issue', '1', '--config', file, '--json'])
    assert.equal(issue.code, 0, issue.err)
    const made = JSON.parse(issue.out)
    assert.equal(made.created, true)
    assert.equal(made.issue.number, 41)
    assert.equal(made.comment.github.issue.number, 41)
    assert.match(issue.err, /Solo engine: started for this command/)
    assert.equal(engineTarget(config), null, 'stopped when the command ended')
    const [post] = gh.requests.filter((request) => request.method === 'POST')
    assert.equal(post.auth, `Bearer ${GH_TOKEN}`)
    assert.match(post.body.title, /^Home: Bigger logo/)
    // The link back goes to the engine's board (its /w/<workspace>/p/<project>/ path), not a 1.x board's API.
    assert.match(post.body.body, /\[comment #1\]\(http:\/\/127\.0\.0\.1:\d+\/w\/ws_[^/]+\/p\/[^/?]+\/\?/)
    assert.doesNotMatch(post.body.body, /api\/boards\//)
    assert.match(post.body.body, /<!-- shapewall:sample\/1 -->/)

    // Asked again: the engine has it, GitHub is not asked.
    const again = await cli(['github', 'issue', '1', '--config', file])
    assert.equal(again.code, 0, again.err)
    assert.match(again.out, /Already has issue #41 for comment #1/)
    assert.equal(gh.requests.filter((request) => request.method === 'POST').length, 1)

    // A merged pull request linked by hand resolves the comment, with the PR as its fix and a reply from github.
    const link = await cli(['github', 'link', '1', '#5', '--config', file])
    assert.equal(link.code, 0, link.err)
    assert.match(link.out, /Linked pull request #5 \[merged\] to comment #1; it has merged, so the comment is resolved/)

    // Sync: PR 6 names comment 2 in its description; PR 5 is listed again and changes nothing.
    const sync = await cli(['github', 'sync', '--config', file, '--json'])
    assert.equal(sync.code, 0, sync.err)
    const synced = JSON.parse(sync.out)
    assert.deepEqual(
      synced.linked.map((item) => [item.comment, item.pull, item.state]),
      [[2, 6, 'open']],
    )
    assert.deepEqual(synced.merged, [])
    // Its state is in the engine's project folder, not the 1.x .shapewall/.
    assert.equal(JSON.parse(fs.readFileSync(path.join(home.outputDir, 'github-sync.json'), 'utf8')).repo, 'acme/site')
    assert.equal(fs.existsSync(path.join(config.outputDir, 'github-sync.json')), false)
    assert.equal(engineTarget(config), null)
  })
  // No GitHub token ever went anywhere but the stand-in.
  assert.ok(gh.requests.every((request) => request.auth === `Bearer ${GH_TOKEN}`))

  // What the board holds now, read through the engine as an agent would.
  const listed = await cli(['comments', 'list', '--config', file, '--all', '--json'])
  assert.equal(listed.code, 0, listed.err)
  const byId = Object.fromEntries(JSON.parse(listed.out).comments.map((item) => [item.id, item]))
  assert.equal(byId[1].status, 'resolved')
  assert.equal(byId[1].resolution, 'Merged in pull request #5 (Bigger logo).')
  assert.equal(byId[1].fixRef, 'https://github.com/acme/site/pull/5')
  assert.equal(byId[1].github.issue.url, 'https://github.com/acme/site/issues/41')
  assert.deepEqual(
    byId[1].github.pulls.map((pull) => [pull.number, pull.state, pull.via, pull.mergedAt]),
    [[5, 'merged', 'manual', MERGED_AT]],
  )
  const fromGithub = byId[1].replies.filter((reply) => reply.author === 'github')
  assert.equal(fromGithub.length, 1, 'one reply for the merge, not one per sync')
  assert.equal(fromGithub[0].body, 'Merged pull request #5 (Bigger logo): https://github.com/acme/site/pull/5')
  assert.equal(byId[2].status, 'open')
  assert.deepEqual(
    byId[2].github.pulls.map((pull) => [pull.number, pull.state, pull.via]),
    [[6, 'open', 'body']],
  )
})

test('github on the engine: an unknown comment is refused before GitHub is asked', async (t) => {
  const { file } = await migratedProject('github-engine-errors')
  const gh = await standIn()
  t.after(() => gh.server.close())
  await withGithub(gh.url, async () => {
    const missing = await cli(['github', 'link', '99', '5', '--config', file])
    assert.notEqual(missing.code, 0)
    assert.match(missing.err, /comment/i)
    assert.equal(gh.requests.length, 0, 'GitHub is not asked about a comment the board does not have')
  })
})

// The same two GitHub tools `shapewall mcp` has on a 1.x board, on the solo engine: this process asks the stand-in
// with its own token, and the engine records the link. The engine's own /mcp never lists them.
test('mcp on the solo engine: create_github_issue and link_pull_request record their links on the engine', async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { createRemoteMcpServer } = await import('../src/remote/remote-mcp.js')
  const { createRemote } = await import('../src/remote/remote.js')
  const { pinSoloLoopback } = await import('../src/remote/loopback-pin.js')
  const { serveEngine } = await import('../src/hosted/solo/serve.js')
  const { startHosted } = await import('../src/hosted/server.js')
  const { config } = await migratedProject('github-engine-mcp')
  const gh = await standIn()
  t.after(() => gh.server.close())
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0, 'no-chat': true }, () => {}, {
    env: ENV,
    start: (options) => startHosted({ ...options, exitOnStop: false }),
  })
  t.after(() => handle.stop())
  await pinSoloLoopback()
  const target = engineTarget(config)
  const env = { ...ENV, SHAPEWALL_GITHUB_TOKEN: GH_TOKEN, SHAPEWALL_GITHUB_API_URL: gh.url }
  const connect = async (options) => {
    const server = await createRemoteMcpServer({
      remote: createRemote({ origin: target.origin, token: target.token, source: 'engine' }),
      config,
      env,
      ...options,
    })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'github-engine', version: '1.0.0' })
    await server.connect(a)
    await client.connect(b)
    t.after(() => client.close())
    return client
  }
  const names = async (client) => (await client.listTools()).tools.map((tool) => tool.name)
  // Not for a remote board reached another way (no localAuthor), nor read-only.
  assert.ok(!(await names(await connect({}))).includes('create_github_issue'))
  assert.ok(!(await names(await connect({ localAuthor: true, readOnly: true }))).includes('create_github_issue'))
  const client = await connect({ localAuthor: true })
  const tools = await names(client)
  assert.ok(tools.includes('create_github_issue') && tools.includes('link_pull_request'), tools.join(', '))
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    assert.ok(!result.isError, result.content?.[0]?.text)
    return JSON.parse(result.content[0].text)
  }
  const made = await call('create_github_issue', { id: 1 })
  assert.equal(made.created, true)
  assert.equal(made.issue.number, 41)
  const linked = await call('link_pull_request', { id: 1, pr: '#5' })
  assert.equal(linked.merged, true)
  assert.equal(linked.status, 'resolved')
  assert.ok(
    gh.requests.every((request) => request.auth === `Bearer ${GH_TOKEN}`),
    'the GitHub token went to GitHub only',
  )
  // Kept on the engine's comment.
  const { comment } = await createRemote({ origin: target.origin, token: target.token, source: 'engine' }).comment('sample', 1, {
    guests: true,
  })
  assert.equal(comment.github.issue.number, 41)
  assert.deepEqual(
    comment.github.pulls.map((pull) => [pull.number, pull.state, pull.via]),
    [[5, 'merged', 'manual']],
  )
})
