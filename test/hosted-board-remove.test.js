// Removing one board of a hosted project in the console: who may, what a
// wrong id answers, what goes (rows, files, storage) and what stays (the
// other board and its comments), the audit entry and the live event.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { changeEventType } from '../src/hosted/events.js'
import { b64, pngWithText } from './comment-media-fixtures.js'
import { createProject, createToken, invite, reauth, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig } from './helpers.js'

let hosted
let alice
let mel
let bob
let ws
let project
let token
const pin = { pageId: 'home', viewport: 'desktop', x: 10, y: 10 }
const boardApi = (rest = '') => `/w/${ws}/p/${project.id}/api${rest}`
const consoleUrl = (boardId, projectId = project.id, workspace = ws) =>
  `/api/workspaces/${workspace}/projects/${projectId}/boards/${boardId}`
const boardFolder = (boardId) => path.join(hosted.dataDir, 'files', ws, project.id, boardId)
const count = (table, boardId) =>
  hosted.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND board_id = ?`).get(project.id, boardId).n

// Pushes a board with the sample pages under another id.
async function pushBoard(boardId, pushToken = token) {
  const config = sampleConfig(`board-remove-${boardId}-${Date.now()}`, { id: boardId, title: boardId })
  writeLocalCaptures(config, boardId)
  const remote = createRemote({ origin: hosted.origin, token: pushToken })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, boardId, 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

before(async () => {
  hosted = await startHostedServer('hosted-board-remove', { signup: 'open' })
  alice = await signUp(hosted, { handle: 'alice' })
  ws = alice.workspaceId
  mel = await signUp(hosted, { handle: 'mel', invite: await invite(alice, ws, 'member') })
  bob = await signUp(hosted, { handle: 'bob' })
  project = await createProject(alice, ws, 'Site')
  token = await createToken(alice, ws, project.id, ['read', 'comment', 'resolve', 'push'])
  await pushBoard('keep')
  await pushBoard('mistake')
  for (const [boardId, body] of [
    ['keep', 'Stays with its board'],
    ['mistake', 'Goes with its board'],
  ]) {
    const posted = await alice.browser.post(boardApi(`/boards/${boardId}/comments`), {
      ...pin,
      body,
      images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    })
    assert.equal(posted.status, 201, posted.text)
    const reply = await mel.browser.post(boardApi(`/boards/${boardId}/comments/${posted.json.comment.id}/replies`), { body: 'A reply' })
    assert.equal(reply.status, 201, reply.text)
  }
})
after(() => hosted?.close())

test('only an admin with a fresh passkey check removes a board; wrong ids and other workspaces answer 404', async () => {
  // A member may not (the same role as deleting the project).
  const member = await mel.browser.call('DELETE', consoleUrl('mistake'))
  assert.equal(member.status, 403)
  assert.equal(member.json.error.code, 'forbidden')
  // Another workspace's admin: this workspace does not exist for them, and
  // their own workspace has no such project.
  await reauth(bob)
  assert.equal((await bob.browser.call('DELETE', consoleUrl('mistake'))).status, 404)
  assert.equal((await bob.browser.call('DELETE', consoleUrl('mistake', project.id, bob.workspaceId))).status, 404)
  // The admin, with a sign-in that is not fresh: asked for the passkey.
  hosted.db
    .prepare('UPDATE sessions SET verified_at = ? WHERE user_id = ?')
    .run(new Date(Date.now() - 30 * 60_000).toISOString(), alice.user.id)
  const stale = await alice.browser.call('DELETE', consoleUrl('mistake'))
  assert.equal(stale.status, 403)
  assert.equal(stale.json.error.code, 'reauth_required')
  await reauth(alice)
  for (const id of ['nope', 'Not%20An%20Id', '..', 'a'.repeat(80)]) {
    const unknown = await alice.browser.call('DELETE', consoleUrl(id))
    assert.equal(unknown.status, 404, id)
    assert.equal(unknown.json.error.code, 'unknown_board', id)
  }
  // Nothing was touched by any of that.
  assert.equal(count('boards', 'mistake'), 1)
  assert.equal(count('comments', 'mistake'), 1)
  assert.ok(fs.existsSync(path.join(boardFolder('mistake'), 'captures', 'manifest.json')))
})

test('removing a board deletes its rows and files, lowers the storage count, and leaves the other board whole', async () => {
  const storage = () => hosted.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = ?').get(ws).n
  const images = () => hosted.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM comment_files WHERE workspace_id = ?').get(ws).n
  const before = { storage: storage(), images: images() }
  const row = hosted.db.prepare('SELECT bytes FROM boards WHERE project_id = ? AND board_id = ?').get(project.id, 'mistake')
  assert.ok(row.bytes > 0)
  // A push left open for the board goes too, with its staging folder.
  const config = sampleConfig('board-remove-open-push', { id: 'mistake', title: 'mistake' })
  const open = await createRemote({ origin: hosted.origin, token }).startPush(pushDefinition(config, config.boards[0]))
  assert.ok(fs.existsSync(path.join(hosted.dataDir, 'staging', open.id)))
  const events = []
  const unsubscribe = hosted.app.locals.events?.subscribe((event) => events.push(event))

  await reauth(alice)
  const gone = await alice.browser.call('DELETE', consoleUrl('mistake'))
  assert.equal(gone.status, 200, gone.text)
  assert.equal(gone.json.board, 'mistake')
  assert.equal(gone.json.comments, 1)
  unsubscribe?.()

  for (const table of ['boards', 'comments', 'comment_files', 'pushes', 'agent_claims', 'agent_approvals', 'comment_imports'])
    assert.equal(count(table, 'mistake'), 0, table)
  assert.equal(fs.existsSync(boardFolder('mistake')), false, 'the board folder is gone')
  assert.equal(fs.existsSync(path.join(hosted.dataDir, 'staging', open.id)), false, 'the open push lost its staging folder')
  assert.equal(storage(), before.storage - row.bytes, 'pushed bytes no longer count')
  assert.ok(images() < before.images, 'nor do its comment images')

  // The board API no longer knows it; the other board, its comment, reply and image are intact.
  assert.equal((await alice.browser.get(boardApi('/boards/mistake'))).status, 404)
  assert.equal((await alice.browser.get(boardApi('/boards/mistake/comments'))).status, 404)
  const kept = await alice.browser.get(boardApi('/boards/keep/comments'))
  assert.equal(kept.status, 200)
  assert.equal(kept.json.comments.length, 1)
  assert.equal(kept.json.comments[0].body, 'Stays with its board')
  assert.equal(kept.json.comments[0].replies.length, 1)
  const image = kept.json.comments[0].images[0].file
  assert.equal((await alice.browser.get(boardApi(`/boards/keep/comment-files/${image}`))).status, 200)
  assert.ok(fs.existsSync(path.join(boardFolder('keep'), 'captures', 'manifest.json')))
  const listed = await alice.browser.get(`/api/workspaces/${ws}`)
  assert.deepEqual(
    listed.json.projects.find((item) => item.id === project.id).boards.map((board) => board.id),
    ['keep'],
  )
  // The project's token still works.
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE project_id = ? AND revoked_at IS NULL').get(project.id).n, 1)

  // The audit log says who removed what.
  const audit = await alice.browser.get(`/api/workspaces/${ws}/audit`)
  const entry = audit.json.entries.find((item) => item.action === 'board_removed')
  assert.ok(entry, 'an audit entry')
  assert.equal(entry.target, `${project.id}/mistake`)
  assert.equal(entry.detail.comments, 1)
  assert.equal(entry.detail.project, 'Site')
  // Watchers heard of it (when the server exposes its bus to tests).
  if (hosted.app.locals.events) {
    const event = events.find((item) => item.type === 'board.removed')
    assert.ok(event, 'a board.removed event')
    assert.deepEqual([event.workspace, event.project, event.board], [ws, project.id, 'mistake'])
  }
  // Twice is a 404.
  assert.equal((await alice.browser.call('DELETE', consoleUrl('mistake'))).status, 404)
})

test('the change event: only DELETE on the board itself is board.removed', () => {
  const url = `/api/workspaces/${ws}/projects/${project.id}/boards/mistake`
  assert.equal(changeEventType(url, 'DELETE'), 'board.removed')
  assert.equal(changeEventType(url, 'POST'), null)
  assert.equal(changeEventType(url), null)
  assert.equal(changeEventType(`${url}/comments`, 'POST'), 'comment.created')
  assert.equal(changeEventType(`${url}/comments/3`, 'DELETE'), 'comment.updated')
})

test('a later push of the same id starts a new board: captures back, comments not; the last board gone leaves an empty project', async () => {
  await pushBoard('mistake')
  const back = await alice.browser.get(boardApi('/boards/mistake/comments'))
  assert.equal(back.status, 200)
  assert.deepEqual(back.json.comments, [])
  assert.ok(fs.existsSync(path.join(boardFolder('mistake'), 'captures', 'manifest.json')))
  const posted = await alice.browser.post(boardApi('/boards/mistake/comments'), { ...pin, body: 'First again' })
  assert.equal(posted.json.comment.id, 1, 'comment numbers start over')

  await reauth(alice)
  for (const id of ['mistake', 'keep']) assert.equal((await alice.browser.call('DELETE', consoleUrl(id))).status, 200)
  const listed = await alice.browser.get(`/api/workspaces/${ws}`)
  const mine = listed.json.projects.find((item) => item.id === project.id)
  assert.ok(mine, 'the project stays')
  assert.deepEqual(mine.boards, [])
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE project_id = ?').get(project.id).n, 0)
})
