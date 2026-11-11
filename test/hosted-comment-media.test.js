// Images and drawings on comments of hosted boards: stored in the database
// (a push replaces the board folder), served behind the comment's own access
// rule, refused for share link guests (who may still draw), counted against
// the storage quota, deleted with their comment, exported, imported, and
// handed to agents as token API URLs with a rendered markup PNG.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { COMMENT_FILE_RE } from '../src/comment-fields.js'
import { loadConfig } from '../src/config.js'
import { createComment } from '../src/store.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { commentUploads, portableComment, share } from '../src/remote/share.js'
import { planWorkspaceExport, writeWorkspaceExport } from '../src/hosted/admin.js'
import { tenant } from '../src/hosted/tenancy.js'
import { readZip } from '../src/hosted/zip.js'
import { b64, jpegWithExif, pngWithText } from './comment-media-fixtures.js'
import {
  createBrowser,
  createProject,
  createToken,
  reauth,
  signUp,
  startHostedServer,
  tokenCall,
  writeLocalCaptures,
} from './hosted-helpers.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

let hosted
let alice
let bob
let ws
let project
let other
let token
const VERSION = '20261101T100000000Z-ab12'
const DRAWING = {
  shapes: [
    {
      tool: 'box',
      ink: 'bad',
      width: 3,
      points: [
        [0.1, 0.1],
        [0.6, 0.5],
      ],
    },
    {
      tool: 'arrow',
      points: [
        [0.9, 0.9],
        [0.5, 0.5],
      ],
    },
  ],
}
const pin = { pageId: 'home', viewport: 'desktop', x: 10, y: 10 }
const boardApi = (projectId, rest = '') => `/w/${ws}/p/${projectId}/api${rest}`

async function pushSample(pushToken, label) {
  const config = sampleConfig(`comment-media-${label}`)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: pushToken })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

// Binary GETs with a token (tokenCall reads text).
async function tokenBytes(url, bearer = token) {
  const response = await fetch(url.replace(hosted.origin, `http://127.0.0.1:${hosted.port}`), {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) }
}

const fileRows = () => hosted.db.prepare('SELECT * FROM comment_files WHERE project_id = ? ORDER BY created_at').all(project.id)

before(async () => {
  hosted = await startHostedServer('hosted-comment-media', { signup: 'open' })
  alice = await signUp(hosted, { handle: 'alice' })
  bob = await signUp(hosted, { handle: 'bob' })
  ws = alice.workspaceId
  project = await createProject(alice, ws, 'Site')
  other = await createProject(alice, ws, 'Other')
  token = await createToken(alice, ws, project.id, ['read', 'comment', 'resolve', 'push'])
  await pushSample(token, 'site')
  await pushSample(await createToken(alice, ws, other.id), 'other')
})
after(() => hosted?.close())

let made
let reply

test('a member attaches images and a drawing; they are cleaned, stored in the database and served as images', async () => {
  const posted = await alice.browser.post(boardApi(project.id, '/boards/sample/comments'), {
    ...pin,
    body: 'This header is off',
    images: [{ name: 'shot.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    drawing: DRAWING,
  })
  assert.equal(posted.status, 201, posted.text)
  made = posted.json.comment
  assert.equal(made.images.length, 1)
  const [image] = made.images
  assert.match(image.file, COMMENT_FILE_RE)
  assert.deepEqual([image.name, image.mediaType, image.width, image.height], ['shot.png', 'image/png', 4, 3])
  assert.equal(made.drawing.shapes.length, 2)
  assert.equal(made.drawing.captureVersion, made.captureVersion, 'the drawing is on the comment capture')
  assert.equal(made.captureVersion, VERSION)

  // Not in the board folder (a push replaces it): in comment_files.
  const rows = fileRows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].comment_number, made.id)
  assert.equal(rows[0].bytes, image.bytes)
  assert.equal(fs.existsSync(path.join(hosted.dataDir, 'files', ws, project.id, 'sample', 'comment-files')), false)

  const served = await alice.browser.get(boardApi(project.id, `/boards/sample/comment-files/${image.file}`))
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-type'], 'image/png')
  assert.equal(served.headers['x-content-type-options'], 'nosniff')
  assert.equal(served.headers['content-security-policy'], "default-src 'none'; sandbox")
  assert.equal(served.headers['cross-origin-resource-policy'], 'same-origin')
  assert.equal(served.body.length, image.bytes)
  assert.ok(!served.body.includes(Buffer.from('secret-gps')), 'the PNG was re-encoded without its text chunk')

  const listed = (await alice.browser.get(boardApi(project.id, '/boards/sample/comments'))).json.comments
  assert.deepEqual(listed[0].images, made.images)
  assert.deepEqual(listed[0].drawing, made.drawing)

  // A reply with a JPEG and a drawing on the capture current now.
  const replied = await alice.browser.post(boardApi(project.id, `/boards/sample/comments/${made.id}/replies`), {
    body: 'And here',
    images: [{ name: 'photo.jpg', mediaType: 'image/jpeg', data: b64(jpegWithExif({ width: 32, height: 16 })) }],
    drawing: {
      shapes: [
        {
          tool: 'pen',
          points: [
            [0.2, 0.2],
            [0.3, 0.4],
            [0.5, 0.3],
          ],
        },
      ],
    },
  })
  assert.equal(replied.status, 201, replied.text)
  reply = replied.json.reply
  assert.equal(reply.images[0].mediaType, 'image/jpeg')
  assert.equal(reply.drawing.captureVersion, VERSION)
  const replyImage = await alice.browser.get(boardApi(project.id, `/boards/sample/comment-files/${reply.images[0].file}`))
  assert.equal(replyImage.headers['content-type'], 'image/jpeg')
  assert.ok(!replyImage.body.includes(Buffer.from('GPS secret-location')), 'EXIF dropped')

  // Bad input never stores anything.
  const before = fileRows().length
  const wrongType = await alice.browser.post(boardApi(project.id, '/boards/sample/comments'), {
    ...pin,
    body: 'x',
    images: [{ name: 'a.png', mediaType: 'image/png', data: b64(Buffer.from('<svg onload=alert(1)>')) }],
  })
  assert.equal(wrongType.status, 415)
  const tooMany = await alice.browser.post(boardApi(project.id, '/boards/sample/comments'), {
    ...pin,
    body: 'x',
    images: Array.from({ length: 5 }, () => ({ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) })),
  })
  assert.equal(tooMany.json.error.code, 'too_many_images')
  const badPin = await alice.browser.post(boardApi(project.id, '/boards/sample/comments'), {
    pageId: 'nope',
    viewport: 'desktop',
    x: 1,
    y: 1,
    body: 'x',
    images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
  })
  assert.equal(badPin.json.error.code, 'unknown_page')
  assert.equal(fileRows().length, before)
  // The big body limit is only on these two routes.
  const big = await alice.browser.call('PATCH', boardApi(project.id, `/boards/sample/comments/${made.id}`), {
    body: { body: 'x'.repeat(70 * 1024) },
  })
  assert.equal(big.status, 413)
  // A name that is not one Shapewall writes, or one it never stored: 404.
  for (const name of ['../shapewall.db', 'aaaaaaaaaaaaaaaaaaaaaaaa.png', `${image.id}.svg`])
    assert.equal((await alice.browser.get(boardApi(project.id, `/boards/sample/comment-files/${encodeURIComponent(name)}`))).status, 404)
})

test('another workspace or another project of the same workspace never reaches the image', async () => {
  const file = made.images[0].file
  // Bob's own workspace has no such board or file; Alice's workspace is not his.
  assert.equal((await bob.browser.get(boardApi(project.id, `/boards/sample/comment-files/${file}`))).status, 404)
  const bobProject = await createProject(bob, bob.workspaceId, 'Site')
  assert.equal((await bob.browser.get(`/w/${bob.workspaceId}/p/${bobProject.id}/api/boards/sample/comment-files/${file}`)).status, 404)
  // Same workspace, same board id, other project: 404.
  assert.equal((await alice.browser.get(boardApi(other.id, `/boards/sample/comment-files/${file}`))).status, 404)
  // A token of the other project: 404.
  const otherToken = await createToken(alice, ws, other.id, ['read'])
  assert.equal((await tokenBytes(`${hosted.origin}/api/v1/boards/sample/comment-files/${file}`, otherToken)).status, 404)
})

test('a guest of a comment link cannot attach images but can draw, and sees the images of comments', async () => {
  await reauth(alice)
  assert.equal((await alice.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })).status, 200)
  const link = await alice.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { mode: 'comment' })
  assert.equal(link.status, 201, link.text)
  const sid = link.json.share.id
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post(`/s/${sid}/open`, { token: new URL(link.json.url).hash.slice(1), name: 'Gus' })).status, 200)
  const before = fileRows().length
  const refused = await guest.post(`/s/${sid}/api/boards/sample/comments`, {
    ...pin,
    body: 'Look',
    images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'guest_no_images')
  assert.equal(refused.json.error.message, 'Guests on a share link cannot attach images.')
  const refusedReply = await guest.post(`/s/${sid}/api/boards/sample/comments/${made.id}/replies`, {
    body: 'Look',
    images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
  })
  assert.equal(refusedReply.json.error.code, 'guest_no_images')
  assert.equal(fileRows().length, before)
  const drawn = await guest.post(`/s/${sid}/api/boards/sample/comments`, { ...pin, body: 'Circled it', drawing: DRAWING })
  assert.equal(drawn.status, 201, drawn.text)
  assert.equal(drawn.json.comment.drawing.shapes.length, 2)
  assert.equal(drawn.json.comment.images, undefined)
  // A guest's body stays small: a drawing fits, a big upload does not.
  const huge = await guest.post(`/s/${sid}/api/boards/sample/comments`, { ...pin, body: 'x', padding: 'x'.repeat(200 * 1024) })
  assert.equal(huge.status, 413)

  const seen = (await guest.get(`/s/${sid}/api/boards/sample/comments`)).json.comments.find((item) => item.id === made.id)
  assert.deepEqual(seen.images, made.images)
  assert.deepEqual(seen.drawing, made.drawing)
  assert.deepEqual(seen.replies[0].images, reply.images)
  const served = await guest.get(`/s/${sid}/api/boards/sample/comment-files/${made.images[0].file}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-type'], 'image/png')
  assert.equal(served.headers['x-content-type-options'], 'nosniff')
})

test('a public project visitor sees images like comments, and cannot post', async () => {
  await reauth(alice)
  assert.equal((await alice.browser.call('PATCH', `/api/workspaces/${ws}/public-projects`, { body: { enabled: true } })).status, 200)
  const made2 = await alice.browser.call('PUT', `/api/workspaces/${ws}/projects/${project.id}/public`, { body: { public: true } })
  assert.equal(made2.status, 200, made2.text)
  const publicId = made2.json.public.id
  const visitor = createBrowser(hosted.port, hosted.origin)
  const comment = (await visitor.get(`/p/${publicId}/api/boards/sample/comments`)).json.comments.find((item) => item.id === made.id)
  assert.deepEqual(comment.images, made.images)
  const served = await visitor.get(`/p/${publicId}/api/boards/sample/comment-files/${made.images[0].file}`)
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-security-policy'], "default-src 'none'; sandbox")
  const posted = await visitor.post(`/p/${publicId}/api/boards/sample/comments`, { ...pin, body: 'x' })
  assert.equal(posted.status, 403)
})

test('an image over the storage quota is refused with 413 quota_exceeded, and counts against pushes', async () => {
  const quota = 5 * 1024 ** 3
  const row = hosted.db.prepare('SELECT bytes FROM boards WHERE project_id = ? AND board_id = ?').get(project.id, 'sample')
  hosted.db.prepare('UPDATE boards SET bytes = ? WHERE project_id = ? AND board_id = ?').run(quota - 50, project.id, 'sample')
  try {
    const before = fileRows().length
    const refused = await alice.browser.post(boardApi(project.id, '/boards/sample/comments'), {
      ...pin,
      body: 'Too much',
      images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    })
    assert.equal(refused.status, 413)
    assert.equal(refused.json.error.code, 'quota_exceeded')
    assert.equal(fileRows().length, before)
    // A drawing alone adds no bytes.
    const drawn = await alice.browser.post(boardApi(project.id, '/boards/sample/comments'), { ...pin, body: 'Just ink', drawing: DRAWING })
    assert.equal(drawn.status, 201)
  } finally {
    hosted.db.prepare('UPDATE boards SET bytes = ? WHERE project_id = ? AND board_id = ?').run(row.bytes, project.id, 'sample')
  }
  // A push that replaces the board fits beside the other boards, but not
  // beside them and the comment images: refused.
  const otherRow = hosted.db.prepare('SELECT bytes FROM boards WHERE project_id = ? AND board_id = ?').get(other.id, 'sample')
  const images = hosted.db.prepare('SELECT SUM(bytes) AS n FROM comment_files WHERE workspace_id = ?').get(ws).n
  assert.ok(images > 0)
  hosted.db
    .prepare('UPDATE boards SET bytes = ? WHERE project_id = ? AND board_id = ?')
    .run(quota - row.bytes - images + 1, other.id, 'sample')
  try {
    await assert.rejects(
      () => pushSample(token, 'again'),
      (error) => error.status === 413 && error.code === 'quota_exceeded',
    )
  } finally {
    hosted.db.prepare('UPDATE boards SET bytes = ? WHERE project_id = ? AND board_id = ?').run(otherRow.bytes, other.id, 'sample')
  }
  assert.equal((await pushSample(token, 'fits')).board, 'sample', 'with room again, the push goes through')
})

test('agents get image and markup URLs; the markup renders the drawing on its capture, the same bytes each time', async () => {
  const listed = await tokenCall(hosted, token, 'GET', '/api/v1/boards/sample/comments?status=all')
  assert.equal(listed.status, 200, listed.text)
  const item = listed.json.comments.find((comment) => comment.id === made.id)
  const [image] = item.files.images
  assert.deepEqual(Object.keys(image).sort(), ['bytes', 'height', 'mediaType', 'name', 'url', 'width'])
  assert.equal(image.url, `${hosted.origin}/api/v1/boards/sample/comment-files/${made.images[0].file}`)
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.bytes, made.images[0].bytes)
  assert.equal(item.files.markup, `${hosted.origin}/api/v1/boards/sample/comment-files/markup-${made.id}.png`)
  assert.equal(item.drawing.shapes, 2)
  assert.deepEqual(item.drawing.tools, ['box', 'arrow'])
  assert.ok(!JSON.stringify(item).includes(hosted.dataDir), 'no server paths')
  const replyItem = item.replies.find((entry) => entry.id === reply.id)
  assert.equal(replyItem.images[0].url, `${hosted.origin}/api/v1/boards/sample/comment-files/${reply.images[0].file}`)
  assert.equal(replyItem.markup, `${hosted.origin}/api/v1/boards/sample/comment-files/markup-${made.id}-r${reply.id}.png`)

  const fetched = await tokenBytes(image.url)
  assert.equal(fetched.status, 200)
  assert.equal(fetched.headers['content-type'], 'image/png')
  assert.equal(fetched.headers['x-content-type-options'], 'nosniff')
  const markup = await tokenBytes(item.files.markup)
  assert.equal(markup.status, 200)
  assert.equal(markup.headers['content-type'], 'image/png')
  const png = PNG.sync.read(markup.body)
  assert.ok(png.width > 0 && png.height > 0)
  assert.deepEqual((await tokenBytes(item.files.markup)).body, markup.body, 'deterministic')
  assert.equal((await tokenBytes(replyItem.markup)).status, 200)
  // A comment without a drawing, a reply that does not exist: 404.
  assert.equal((await tokenBytes(`${hosted.origin}/api/v1/boards/sample/comment-files/markup-${made.id}-r99.png`)).status, 404)
  assert.equal((await tokenBytes(`${hosted.origin}/api/v1/boards/sample/comment-files/markup-9999.png`)).status, 404)
  // One comment, read alone, has the same files.
  const one = await tokenCall(hosted, token, 'GET', `/api/v1/boards/sample/comments/${made.id}`)
  assert.deepEqual(one.json.comment.files.images, item.files.images)
})

test('a workspace export holds the images, listed in comments.json', async () => {
  const t = tenant(hosted.db, ws)
  const iso = () => new Date().toISOString()
  const projects = hosted.db.prepare('SELECT * FROM projects WHERE workspace_id = ?').all(ws)
  const exported = planWorkspaceExport(t, { dataDir: hosted.dataDir, projects, iso })
  const chunks = []
  await writeWorkspaceExport(t, exported, { write: (b) => chunks.push(Buffer.from(b)), now: new Date(), iso, exportedBy: 'fixture' })
  const files = readZip(Buffer.concat(chunks))
  const root = Object.keys(files)[0].split('/')[0]
  const base = `${root}/projects/${project.slug}/boards/sample/`
  const comments = JSON.parse(files[`${base}comments.json`])
  const exportedComment = comments.find((item) => item.id === made.id)
  assert.deepEqual(exportedComment.images, made.images)
  assert.deepEqual(exportedComment.drawing, made.drawing)
  const stored = hosted.db.prepare('SELECT data FROM comment_files WHERE file = ?').get(made.images[0].file).data
  assert.deepEqual(files[`${base}comment-files/${made.images[0].file}`], Buffer.from(stored))
  assert.ok(files[`${base}comment-files/${reply.images[0].file}`])
})

test('deleting a comment deletes its images and its replies’ images', async () => {
  const files = [made.images[0].file, reply.images[0].file]
  const gone = await alice.browser.call('DELETE', boardApi(project.id, `/boards/sample/comments/${made.id}`))
  assert.equal(gone.status, 200, gone.text)
  for (const file of files) {
    assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM comment_files WHERE file = ?').get(file).n, 0)
    assert.equal((await alice.browser.get(boardApi(project.id, `/boards/sample/comment-files/${file}`))).status, 404)
  }
})

test('deleting a project deletes the images of its comments', async () => {
  const doomed = await createProject(alice, ws, 'Doomed')
  await pushSample(await createToken(alice, ws, doomed.id), 'doomed')
  const posted = await alice.browser.post(boardApi(doomed.id, '/boards/sample/comments'), {
    ...pin,
    body: 'Goes with the project',
    images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
  })
  assert.equal(posted.status, 201, posted.text)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM comment_files WHERE project_id = ?').get(doomed.id).n, 1)
  await reauth(alice)
  assert.equal((await alice.browser.call('DELETE', `/api/workspaces/${ws}/projects/${doomed.id}`)).status, 200)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM comment_files WHERE project_id = ?').get(doomed.id).n, 0)
})

// ---- Imports (shapewall share) ----

async function importToken(projectId) {
  hosted.rateLimiter.reset()
  const started = await createBrowser(hosted.port, hosted.origin).post('/api/v1/device/start', {
    name: 'Fixture computer',
    purpose: 'import',
  })
  assert.equal(started.status, 201, started.text)
  const approve = await alice.browser.post('/api/device/approve', {
    code: started.json.userCode,
    workspaceId: ws,
    projectId,
    scopes: ['read', 'push', 'import'],
  })
  assert.equal(approve.status, 200, approve.text)
  return (await createBrowser(hosted.port, hosted.origin).post('/api/v1/device/poll', { deviceCode: started.json.deviceCode })).json.token
}

test('an import uploads images first, attaches them by ref and carries drawings', async () => {
  const bearer = await importToken(other.id)
  const sessionId = 'a'.repeat(64)
  const ref = 'b'.repeat(64)
  const upload = (body) => tokenCall(hosted, bearer, 'POST', '/api/v1/boards/sample/import/images', { body })
  const image = { name: 'local.png', mediaType: 'image/png', data: b64(pngWithText()) }
  const first = await upload({ sessionId, ref, image })
  assert.equal(first.status, 201, first.text)
  assert.match(first.json.file, COMMENT_FILE_RE)
  assert.equal((await upload({ sessionId, ref, image })).json.file, first.json.file, 'a retry gets the same file')
  assert.equal((await upload({ sessionId, ref: 'c'.repeat(64), image: { ...image, mediaType: 'image/gif' } })).status, 415)
  // Staged, not served: no comment lists it yet.
  assert.equal((await alice.browser.get(boardApi(other.id, `/boards/sample/comment-files/${first.json.file}`))).status, 404)

  const comment = {
    importKey: 'd'.repeat(64),
    localId: 7,
    ...pin,
    body: 'Imported with a picture',
    author: 'Local',
    status: 'open',
    captureVersion: VERSION,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    images: [{ ref, name: 'local.png' }],
    drawing: DRAWING,
    replies: [
      { author: 'Local', body: 'Reply drawing', createdAt: '2026-11-01T11:00:00.000Z', drawing: { ...DRAWING, captureVersion: VERSION } },
    ],
  }
  const missing = await tokenCall(hosted, bearer, 'POST', '/api/v1/boards/sample/import', {
    body: { sessionId, batchKey: 'e'.repeat(64), comments: [{ ...comment, importKey: 'f'.repeat(64), images: [{ ref: '1'.repeat(64) }] }] },
  })
  assert.equal(missing.json.error.code, 'import_image_missing')
  const batch = await tokenCall(hosted, bearer, 'POST', '/api/v1/boards/sample/import', {
    body: { sessionId, batchKey: '2'.repeat(64), comments: [comment] },
  })
  assert.equal(batch.status, 200, batch.text)
  assert.equal(batch.json.imported, 1)
  const number = batch.json.mappings[0].remoteId
  const shown = (await alice.browser.get(boardApi(other.id, '/boards/sample/comments'))).json.comments.find((item) => item.id === number)
  assert.equal(shown.images[0].file, first.json.file)
  assert.equal(shown.images[0].name, 'local.png')
  assert.equal(shown.drawing.captureVersion, VERSION)
  assert.equal(shown.replies[0].drawing.shapes.length, 2)
  const served = await alice.browser.get(boardApi(other.id, `/boards/sample/comment-files/${first.json.file}`))
  assert.equal(served.status, 200)
  assert.ok(!served.body.includes(Buffer.from('secret-gps')), 'cleaned like an upload')
  // The same batch again: replayed, nothing duplicated.
  const replay = await tokenCall(hosted, bearer, 'POST', '/api/v1/boards/sample/import', {
    body: { sessionId, batchKey: '2'.repeat(64), comments: [comment] },
  })
  assert.equal(replay.status, 200)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM comment_files WHERE project_id = ?').get(other.id).n, 1)
  // Commit drops staged images nobody attached.
  await upload({ sessionId, ref: '3'.repeat(64), image })
  assert.equal(
    hosted.db.prepare('SELECT COUNT(*) AS n FROM comment_files WHERE project_id = ? AND comment_number IS NULL').get(other.id).n,
    1,
  )
  const commit = await tokenCall(hosted, bearer, 'POST', '/api/v1/boards/sample/import', {
    body: { sessionId, batchKey: '4'.repeat(64), comments: [], commit: true },
  })
  assert.equal(commit.status, 200, commit.text)
  assert.equal(
    hosted.db.prepare('SELECT COUNT(*) AS n FROM comment_files WHERE project_id = ? AND comment_number IS NULL').get(other.id).n,
    0,
  )
  assert.equal((await upload({ sessionId, ref: '5'.repeat(64), image })).status, 403, 'the import scope is gone')
})

test('shapewall share sends a local comment’s images and drawing', async () => {
  const target = await createProject(alice, ws, 'Moved')
  const bearer = await importToken(target.id)
  const dir = tempDir('comment-media-share')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(structuredClone(SAMPLE)))
  const config = loadConfig(file)
  writeLocalCaptures(config, 'sample')
  const local = await createComment(config, config.boards[0], {
    ...pin,
    body: 'Local picture',
    author: 'Local Name',
    images: [{ name: 'pic.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    drawing: DRAWING,
  })
  assert.equal(local.images.length, 1)
  const portable = portableComment(local, dir, 'sample')
  const uploads = commentUploads(config, 'sample', local, portable)
  assert.equal(uploads.length, 1)
  assert.equal(portable.images[0].ref, uploads[0].ref)
  assert.ok(!JSON.stringify(portable).includes(dir), 'no local paths')
  const result = await share({ remote: hosted.origin }, () => {}, { config, env: { SHAPEWALL_TOKEN: bearer }, fetchImpl: fetch })
  assert.equal(result.code, 0)
  const moved = (await alice.browser.get(boardApi(target.id, '/boards/sample/comments'))).json.comments
  assert.equal(moved.length, 1)
  assert.equal(moved[0].images.length, 1)
  assert.equal(moved[0].images[0].name, 'pic.png')
  assert.equal(moved[0].drawing.shapes.length, 2)
  const served = await alice.browser.get(boardApi(target.id, `/boards/sample/comment-files/${moved[0].images[0].file}`))
  assert.equal(served.status, 200)
  assert.equal(served.headers['content-type'], 'image/png')
})
