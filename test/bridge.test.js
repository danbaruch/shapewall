import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { addReply, createComment, listComments, readMigration, updateComment, writeMigration } from '../src/store.js'
import { saveCredential } from '../src/remote/credentials.js'
import { createRemote } from '../src/remote/remote.js'
import { importBatches, portableComment, portableManifest, portableVariants, shareFiles, share } from '../src/remote/share.js'
import { hash, mapFile, readMap, updateMap } from '../src/remote/share-state.js'
import { cleanImportedComment } from '../src/hosted/import.js'
import { createBrowser, createProject, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

let hosted, owner, project, config, dir, token, remote
const opts = () => ({ config, env: { SHAPEWALL_TOKEN: token }, fetchImpl: fetch })
const key = (value) => hash(String(value))
const api = (body) => tokenCall(hosted, token, 'POST', '/api/v1/boards/sample/import', { body })
async function moveLogin({ purpose = 'import', newProjectName = null, scopes = ['read', 'push', 'import'] } = {}) {
  hosted.rateLimiter.reset() // Independent approval fixtures do not share an anti-abuse window.
  const started = await createBrowser(hosted.port, hosted.origin).post('/api/v1/device/start', { name: 'Fixture computer', purpose })
  assert.equal(started.status, 201, started.text)
  const approve = await owner.browser.post('/api/device/approve', {
    code: started.json.userCode,
    workspaceId: owner.workspaceId,
    ...(newProjectName ? { newProjectName } : { projectId: project.id }),
    scopes,
  })
  if (approve.status !== 200) return { approve }
  const poll = await createBrowser(hosted.port, hosted.origin).post('/api/v1/device/poll', { deviceCode: started.json.deviceCode })
  return { approve, token: poll.json.token }
}
before(async () => {
  hosted = await startHostedServer('bridge')
  owner = await signUp(hosted, { handle: 'bridgeowner', displayName: 'Bridge Owner' })
  project = await createProject(owner, owner.workspaceId, 'Bridge')
  token = (await moveLogin()).token
  remote = createRemote({ origin: hosted.origin, token })
  dir = tempDir('bridge-local')
  const file = path.join(dir, 'shapewall.config.json')
  const raw = structuredClone(SAMPLE)
  raw.auth = { storageState: 'private-state.json' }
  raw.baseUrl = 'http://fixture-user:FIXTURE_PASSWORD@127.0.0.1:9/?access_token=FIXTURE_TOKEN'
  raw.publicUrl = 'https://fixture-user:FIXTURE_PASSWORD@review.example/path?preview_key=FIXTURE_QUERY#frag'
  raw.pages[0].actions = [{ fill: ['#password', 'credential-never-transfer'] }]
  fs.writeFileSync(file, JSON.stringify(raw))
  config = loadConfig(file)
  writeLocalCaptures(config, 'sample')
  const statuses = [null, 'queued', 'working', 'done', 'needs-human']
  for (let i = 0; i < 25; i++) {
    const comment = await createComment(config, config.boards[0], {
      pageId: i === 24 ? 'pricing' : 'home',
      viewport: 'desktop',
      x: 10,
      y: 15,
      body: `Comment ${i} @agent`,
      author: 'Local Name',
      anchor: { selector: '#price', text: 'Price', dx: 0.5, dy: 0.5 },
    })
    await addReply(config, 'sample', comment.id, { author: 'Local Agent', body: 'Kept reply' })
    await updateComment(config, 'sample', comment.id, {
      agentStatus: statuses[i % 5],
      ...(i % 2 ? { status: 'resolved', resolution: 'Kept note', fixRef: 'https://example.com/fix' } : {}),
    })
  }
})
after(() => hosted?.close())

test('dry-run sends no requests and creates no maps', async () => {
  const lines = []
  const result = await share({ remote: hosted.origin, 'dry-run': true }, (line) => lines.push(line), {
    config,
    env: {},
    fetchImpl: () => {
      throw Error('network called')
    },
  })
  assert.equal(result.code, 0)
  assert.match(lines.join('\n'), /25 comments, 25 replies/)
  assert.equal(fs.existsSync(path.join(config.outputDir, 'remote')), false)
})

test('share moves 25 comments and replies inertly, strips config, saves private map and freezes only comments', async () => {
  const result = await share({ remote: hosted.origin }, () => {}, opts())
  assert.equal(result.code, 0)
  const rows = hosted.db.prepare('SELECT * FROM comments WHERE project_id=? ORDER BY number').all(project.id)
  assert.equal(rows.length, 25)
  for (const row of rows) {
    assert.equal(row.author_user_id, null)
    assert.equal(row.author_handle, null)
    assert.equal(row.author_token_id, null)
    assert.equal(row.imported_by, owner.user.id)
    assert.match(row.author, /\(imported\)$/)
    assert.equal(JSON.parse(row.replies).length, 1)
    assert.equal(JSON.parse(row.replies)[0].handle, undefined)
  }
  assert.equal(rows.filter((row) => row.status === 'resolved').length, 12)
  assert.ok(rows.some((row) => row.agent_status === 'working'))
  assert.equal((await remote.project()).token.scopes.includes('import'), false)
  const definition = hosted.db.prepare('SELECT definition FROM boards WHERE project_id=?').get(project.id).definition
  assert.doesNotMatch(definition, /credential-never-transfer|storageState|FIXTURE_|access_token|preview_key|#frag/)
  assert.equal(JSON.parse(definition).board.pages.find((page) => page.id === 'app').path, '/app?tab=notes')
  const map = readMap(config, hosted.origin)
  assert.equal(Object.keys(map.boards.sample.comments).length, 25)
  assert.equal(fs.statSync(mapFile(config, hosted.origin)).mode & 0o777, 0o600)
  assert.equal(readMigration(config, 'sample').readOnly, true)
  await assert.rejects(
    () => addReply(config, 'sample', 1, { body: 'Blocked', author: 'Local' }),
    (error) => error.code === 'comments_moved',
  )
  const again = await share({ remote: hosted.origin }, () => {}, opts())
  assert.equal(again.code, 0)
  assert.equal(hosted.db.prepare('SELECT count(*) AS n FROM comments WHERE project_id=?').get(project.id).n, 25)
})

test('remote plus local edits conflict, untouched remote updates, and repeat batches are idempotent', async () => {
  await writeMigration(config, 'sample', { ...readMigration(config, 'sample'), readOnly: false })
  const local = listComments(config, 'sample').find((c) => c.id === 1)
  const mapping = readMap(config, hosted.origin).boards.sample.comments[1]
  await updateComment(config, 'sample', 1, { body: 'Local changed after move' })
  hosted.db.prepare('UPDATE comments SET body=? WHERE project_id=? AND number=?').run('Remote kept', project.id, mapping.remoteId)
  token = (await moveLogin()).token
  const result = await share({ remote: hosted.origin }, () => {}, opts())
  assert.equal(result.code, 2)
  assert.deepEqual(result.conflicts, ['sample:1'])
  assert.equal(readMigration(config, 'sample').readOnly, false)
  assert.equal(
    hosted.db.prepare('SELECT body FROM comments WHERE project_id=? AND number=?').get(project.id, mapping.remoteId).body,
    'Remote kept',
  )
  // New valid scope for explicit imports.
  token = (await moveLogin()).token
  const payload = {
    sessionId: key('atomic'),
    batchKey: key('first'),
    comments: [portableComment({ ...local, id: 100, body: 'New imported orphan', pageId: 'gone' }, fs.realpathSync(config.dir), 'sample')],
  }
  const first = await api(payload)
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.imported, 1)
  assert.deepEqual((await api(payload)).json, first.json)
  assert.equal((await api({ ...payload, comments: [{ ...payload.comments[0], body: 'Changed same key' }] })).status, 409)
  const orphan = hosted.db
    .prepare('SELECT import_orphan FROM comments WHERE project_id=? AND number=?')
    .get(project.id, first.json.mappings[0].remoteId)
  assert.equal(orphan.import_orphan, 1)
  const changed = { ...payload.comments[0], body: 'Safe local update', updatedAt: new Date().toISOString() }
  const update = await api({ sessionId: payload.sessionId, batchKey: key('second'), comments: [changed] })
  assert.equal(update.json.updated, 1, update.text)
  const commit = { sessionId: payload.sessionId, batchKey: key('commit'), comments: [], commit: true }
  const committed = await api(commit)
  assert.equal(committed.status, 200, committed.text)
  assert.deepEqual((await api(commit)).json, committed.json, 'lost commit response can replay after scope consumption')
  assert.equal((await api({ ...payload, sessionId: key('newsession') })).status, 403)
})

test('invalid batch rolls back all comments and rejects forged fields and dangerous anchors', async () => {
  token = (await moveLogin()).token
  const source = listComments(config, 'sample')[0]
  const good = portableComment({ ...source, id: 501 }, fs.realpathSync(config.dir), 'sample')
  const count = hosted.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n
  const response = await api({
    sessionId: key('invalid'),
    batchKey: key('invalidbatch'),
    comments: [good, { ...good, importKey: key('invalid2'), x: NaN }],
  })
  assert.equal(response.status, 400, response.text)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, count)
  for (const pageId of [undefined, null, [], {}]) assert.throws(() => cleanImportedComment({ ...good, pageId }), /page id/)
  assert.throws(() => cleanImportedComment({ ...good, anchor: { selector: 'body, *' } }), /selector/)
  assert.throws(() => cleanImportedComment({ ...good, reactions: [{ emoji: '🔥', count: 1 }] }), /reaction/)
  const cleaned = cleanImportedComment({
    ...good,
    authorHandle: 'owner',
    author_user_id: owner.user.id,
    dispatchable: true,
    dispatch_hash: 'forged',
    replies: [{ body: 'Inert', author: 'Bot', handle: 'owner', user: owner.user.id, agent: true, createdAt: source.createdAt }],
  })
  assert.equal(cleaned.authorHandle, undefined)
  assert.equal(cleaned.replies[0].handle, undefined)
  assert.equal(cleaned.dispatch_hash, undefined)
  assert.equal(cleanImportedComment({ ...good, authorKind: 'agent' }).authorKind, 'agent')
  assert.equal(cleanImportedComment({ ...good, authorKind: 'guest' }).authorKind, 'guest')
  assert.throws(() => cleanImportedComment({ ...good, authorKind: 'owner' }), /author kind/)
})

test('import scope requires an explicit moving-project approval and may create a project atomically', async () => {
  const refused = await moveLogin({ purpose: null })
  assert.equal(refused.approve.status, 403)
  const consoleToken = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/tokens`, {
    name: 'No implicit import',
    scopes: ['import'],
  })
  assert.equal(consoleToken.status, 403)
  const created = await moveLogin({ newProjectName: 'Newly moved project' })
  assert.equal(created.approve.status, 200, created.approve.text)
  assert.equal(created.approve.json.project.name, 'Newly moved project')
})

test('map refuses corrupt, public and symlink targets without replacing them', () => {
  const other = loadConfig(config.file)
  other.outputDir = path.join(dir, 'unsafe-output')
  const file = mapFile(other, hosted.origin)
  fs.writeFileSync(file, 'broken', { mode: 0o600 })
  assert.throws(() => updateMap(other, hosted.origin, () => {}), /corrupt/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken')
  fs.chmodSync(file, 0o644)
  assert.throws(() => readMap(other, hosted.origin), /private/)
  const linked = { ...other, outputDir: path.join(dir, 'linked-output') }
  fs.symlinkSync(other.outputDir, linked.outputDir)
  assert.throws(() => mapFile(linked, hosted.origin), /symlink/)
})

test('share CLI is discoverable and dry-run works without a login', async () => {
  const lines = []
  assert.equal(
    await main(['share', '--remote', hosted.origin, '--config', config.file, '--dry-run'], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    }),
    0,
  )
  assert.match(lines.join('\n'), /Would move sample/)
})

test('rich thread batches are byte bounded below the route cap', () => {
  const row = { localId: 1, body: 'x'.repeat(2000), replies: Array.from({ length: 200 }, () => ({ body: 'é'.repeat(2000) })) }
  const batches = importBatches(Array.from({ length: 25 }, (_, i) => ({ ...row, localId: i + 1 })))
  assert.ok(batches.length > 1)
  assert.equal(batches.flat().length, 25)
  for (const comments of batches)
    assert.ok(Buffer.byteLength(JSON.stringify({ comments, sessionId: key('s'), batchKey: key('b') })) < 2 * 1024 * 1024)
  assert.throws(() => importBatches([{ localId: 123, body: 'x'.repeat(2000000) }]), /Comment #123 is too large/)
})

test('failed pushes restore the preceding local comment choice and retain the import grant', async () => {
  token = (await moveLogin()).token
  const before = readMigration(config, 'sample')
  await assert.rejects(
    () =>
      share({ remote: hosted.origin }, () => {}, {
        ...opts(),
        fetchImpl: async (url, options) =>
          String(url).endsWith('/api/v1/pushes')
            ? new Response(JSON.stringify({ error: { message: 'Fixture push refused' } }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              })
            : fetch(url, options),
      }),
    /Fixture push refused/,
  )
  assert.deepEqual(readMigration(config, 'sample'), before)
  const check = createRemote({ origin: hosted.origin, token })
  assert.equal((await check.project()).token.scopes.includes('import'), true)
})

test('all boards import before grant consumption, rich threads use byte-sized batches, and lost final responses resume', async () => {
  const login = await moveLogin({ newProjectName: 'Rich multi-board move' })
  token = login.token
  const isolatedDir = tempDir('bridge-rich')
  const file = path.join(isolatedDir, 'shapewall.config.json')
  const raw = structuredClone(SAMPLE)
  fs.writeFileSync(file, JSON.stringify(raw))
  const rich = loadConfig(file)
  rich.boards.push({ ...rich.boards[0], id: 'second', title: 'Second' })
  for (const board of rich.boards) {
    writeLocalCaptures(rich, board.id)
    const c = await createComment(rich, board, { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Rich thread', author: 'Local' })
    const store = JSON.parse(fs.readFileSync(path.join(rich.outputDir, board.id, 'comments.json'), 'utf8'))
    store.comments[0].replies = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      body: 'é'.repeat(2000),
      author: 'Original',
      createdAt: c.createdAt,
    }))
    fs.writeFileSync(path.join(rich.outputDir, board.id, 'comments.json'), JSON.stringify(store))
  }
  const seen = []
  let lost = true
  const fetchImpl = async (url, options) => {
    const body = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : null
    if (String(url).endsWith('/import')) {
      assert.ok(Buffer.byteLength(options.body) < 2 * 1024 * 1024)
      const project = await createRemote({ origin: hosted.origin, token }).project()
      if (!body.commit) assert.ok(project.token.scopes.includes('import'), 'grant stays until all boards finish')
      seen.push({ board: new URL(url).pathname.split('/')[4], commit: Boolean(body.commit) })
    }
    const response = await fetch(url, options)
    if (body?.commit && lost) {
      lost = false
      throw Error('Fixture lost final response')
    }
    return response
  }
  await assert.rejects(
    () => share({ remote: hosted.origin }, () => {}, { config: rich, env: { SHAPEWALL_TOKEN: token }, fetchImpl }),
    /lost final response/,
  )
  assert.deepEqual(
    seen.map((item) => item.board),
    ['sample', 'second', 'second'],
  )
  assert.equal(seen.at(-1).commit, true)
  const retry = await share({ remote: hosted.origin }, () => {}, { config: rich, env: { SHAPEWALL_TOKEN: token } })
  assert.equal(retry.code, 0)
  assert.equal(readMigration(rich, 'sample').pending, false)
  assert.equal(readMigration(rich, 'second').readOnly, true)
  const destination = login.approve.json.project.id
  const rows = hosted.db.prepare('SELECT * FROM comments WHERE project_id=?').all(destination)
  assert.equal(rows.length, 2)
  assert.equal(JSON.parse(rows[0].replies).length, 200)
})

test('capture wire metadata is a whitelist, with no local paths or identity extras', () => {
  const manifest = portableManifest(config, config.boards[0], {
    capturedAt: '2026-11-01T00:00:00Z',
    durationMs: 10,
    auth: { token: 'never' },
    localPath: '/private/state',
    pages: {
      home: {
        desktop: {
          status: 'failed',
          error: '/private/login.js: SECRET',
          url: 'https://user:SECRET@example.com',
          debug: { key: 'never' },
          html: { status: 'failed', error: '/private/html', agentConfig: { secret: 'never' } },
          links: ['pricing', { token: 'never' }],
        },
      },
    },
  })
  const text = JSON.stringify(manifest)
  assert.doesNotMatch(text, /SECRET|private|never|user:/)
  assert.deepEqual(manifest.pages.home.desktop.links, ['pricing'])
  assert.deepEqual(
    portableVariants([
      { id: 'v', pageId: 'home', title: 'Example', source: '/private/file.html', key: 'never', createdAt: '2026-11-01T00:00:00Z' },
    ]),
    [{ id: 'v', pageId: 'home', title: 'Example', createdAt: '2026-11-01T00:00:00Z' }],
  )
  const comment = portableComment(
    {
      id: 700,
      body: 'Local',
      pageId: 'home',
      viewport: 'desktop',
      x: 1,
      y: 1,
      status: 'open',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      author: 'Agent',
      authorAgent: true,
      authorHandle: 'fake-owner',
      anchor: { selector: '#price', dx: 0.5, dy: 0.5, localPath: '/private', key: 'never' },
      replies: [],
    },
    dir,
    'sample',
  )
  assert.equal(comment.authorKind, 'agent')
  assert.equal(comment.authorHandle, undefined)
  assert.doesNotMatch(JSON.stringify(comment), /private|never|fake-owner/)
})

test('capture symlinks cannot upload another local file, and failed reads restore the comment choice', async () => {
  token = (await moveLogin()).token
  const capture = path.join(config.outputDir, 'sample', 'captures', 'home.desktop.html')
  const backup = `${capture}.saved`
  const outside = path.join(dir, 'private-not-a-capture.html')
  fs.writeFileSync(outside, 'Fixture private file that must never leave this machine')
  fs.renameSync(capture, backup)
  fs.symlinkSync(outside, capture)
  const before = readMigration(config, 'sample')
  try {
    await assert.rejects(() => share({ remote: hosted.origin }, () => {}, opts()), /symlinked capture/)
    assert.deepEqual(readMigration(config, 'sample'), before)
  } finally {
    fs.unlinkSync(capture)
    fs.renameSync(backup, capture)
  }
})

test('an expired saved login restarts device approval instead of stranding the UI', async () => {
  const env = { XDG_CONFIG_HOME: tempDir('bridge-expired-login') }
  saveCredential(hosted.origin, { token, scopes: ['read', 'push'] }, env)
  let first = true,
    asked = false
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/api/v1/project') && first) {
      first = false
      return new Response(JSON.stringify({ error: { code: 'bad_token' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    return fetch(url, options)
  }
  const loginImpl = async (_flags, _out, options) => {
    asked = true
    assert.equal(options.purpose, 'import')
    const next = await moveLogin()
    saveCredential(hosted.origin, { token: next.token, scopes: ['read', 'push', 'import'] }, env)
  }
  const result = await share({ remote: hosted.origin, 'no-comments': true }, () => {}, { config, env, fetchImpl, loginImpl })
  assert.equal(result.code, 0)
  assert.equal(asked, true)
})

// Hold the HTTP body after token admission, so a concurrent grant/revocation
// can happen between authentication and the eventual import transaction.
async function holdImport(body) {
  const bytes = Buffer.from(JSON.stringify(body))
  let admittedResolve
  const admitted = new Promise((resolve) => {
    admittedResolve = resolve
  })
  const previous = hosted.rateLimiter.hit
  hosted.rateLimiter.hit = (bucket, ...args) => {
    const result = previous(bucket, ...args)
    if (bucket === 'token') admittedResolve()
    return result
  }
  let req
  const result = new Promise((resolve, reject) => {
    req = http.request(
      {
        host: '127.0.0.1',
        port: hosted.port,
        path: '/api/v1/boards/sample/import',
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': bytes.length },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(text) }))
      },
    )
    req.on('error', reject)
    req.write(bytes.subarray(0, 1))
  })
  let timer
  try {
    await Promise.race([
      admitted,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Token admission was not reached')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    hosted.rateLimiter.hit = previous
  }
  return { finish: () => req.end(bytes.subarray(1)), result, cancel: () => req.destroy() }
}

test('held imports cannot reuse an import grant consumed after token admission', async () => {
  token = (await moveLogin()).token
  const source = listComments(config, 'sample')[0]
  const body = {
    sessionId: key('held-fresh-session'),
    batchKey: key('held-fresh-batch'),
    comments: [portableComment({ ...source, id: 901 }, fs.realpathSync(config.dir), 'sample')],
  }
  const held = await holdImport(body)
  try {
    const commit = await api({ sessionId: key('other-session-commit'), batchKey: key('consume-held-grant'), comments: [], commit: true })
    assert.equal(commit.status, 200, commit.text)
    assert.equal((await createRemote({ origin: hosted.origin, token }).project()).token.scopes.includes('import'), false)
    held.finish()
    const response = await held.result
    assert.equal(response.status, 403)
    assert.equal(response.json.error.code, 'missing_scope')
    assert.equal(hosted.db.prepare('SELECT count(*) AS n FROM import_sessions WHERE session_id=?').get(body.sessionId).n, 0)
  } finally {
    held.cancel()
  }
})

for (const replay of [false, true])
  for (const revoke of ['revoked', 'expired', 'demoted', 'suspended'])
    test(`held ${replay ? 'replay' : 'new import'} rechecks ${revoke} credentials at mutation boundary`, async () => {
      token = (await moveLogin()).token
      const source = listComments(config, 'sample')[0]
      const body = {
        sessionId: key(`${replay}-${revoke}-session`),
        batchKey: key(`${replay}-${revoke}-batch`),
        comments: [portableComment({ ...source, id: 910 }, fs.realpathSync(config.dir), 'sample')],
      }
      if (replay) assert.equal((await api(body)).status, 200)
      const held = await holdImport(body)
      try {
        if (revoke === 'revoked')
          hosted.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(), key(token))
        if (revoke === 'expired')
          hosted.db.prepare('UPDATE api_tokens SET expires_at=? WHERE token_hash=?').run(new Date(0).toISOString(), key(token))
        if (revoke === 'demoted')
          hosted.db
            .prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?')
            .run('member', owner.workspaceId, owner.user.id)
        if (revoke === 'suspended')
          hosted.db.prepare('UPDATE workspaces SET suspended_at=? WHERE id=?').run(new Date().toISOString(), owner.workspaceId)
        held.finish()
        const response = await held.result
        assert.equal(response.status, 401)
        assert.equal(response.json.error.code, 'bad_token')
      } finally {
        held.cancel()
        if (revoke === 'demoted')
          hosted.db
            .prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?')
            .run('owner', owner.workspaceId, owner.user.id)
        if (revoke === 'suspended') hosted.db.prepare('UPDATE workspaces SET suspended_at=NULL WHERE id=?').run(owner.workspaceId)
      }
    })

test('only configured capture and variant files enter the transfer list', () => {
  const captures = path.join(config.outputDir, 'sample', 'captures')
  for (const name of ['private.html', 'unknown.desktop.html', 'auth-state.elements.json', 'home.other.png'])
    fs.writeFileSync(path.join(captures, name), 'Fixture secret, not a capture')
  const files = shareFiles(config, config.boards[0])
  assert.ok(files.some(([, name]) => name === 'home.desktop.html'))
  for (const [, name] of files) assert.doesNotMatch(name, /private|unknown|auth-state|other/)
})

test('a held commit never restores concurrently removed token scopes', async () => {
  token = (await moveLogin()).token
  const body = { sessionId: key('fresh-commit-scopes'), batchKey: key('fresh-commit-scopes-batch'), comments: [], commit: true }
  const held = await holdImport(body)
  try {
    hosted.db.prepare('UPDATE api_tokens SET scopes=? WHERE token_hash=?').run(JSON.stringify(['read', 'import']), key(token))
    held.finish()
    assert.equal((await held.result).status, 200)
    assert.deepEqual((await createRemote({ origin: hosted.origin, token }).project()).token.scopes, ['read'])
  } finally {
    held.cancel()
  }
})
