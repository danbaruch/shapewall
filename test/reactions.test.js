// Emoji reactions on comments and replies: the shared model, the local store
// and API, the hosted server (roles, guests, tenancy, the token API), the
// public demo's backend, and what agents see (nothing). Older comments with no
// reactions read the same as before, and the edited marker.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REACTIONS, normalizeReactions, publicReactions, toggleReaction, countedReactions } from '../src/reactions.js'
import {
  addReply,
  commentsFile,
  createComment,
  getComment,
  listComments,
  reactToComment,
  updateComment,
  CommentError,
} from '../src/store.js'
import { feedback } from '../src/feedback.js'
import { createApp } from '../src/server/app.js'
import { boardPermissions, guestPermissions } from '../src/hosted/permissions.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { NOTES_PROJECT, seedState } from '../client/src/demo/fixtures.js'
import {
  createBrowser,
  createProject,
  createToken,
  invite,
  reauth,
  signUp,
  startHostedServer,
  tokenCall,
  writeLocalCaptures,
} from './hosted-helpers.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const valid = { pageId: 'home', viewport: 'desktop', x: 10, y: 20, body: 'Bigger logo', author: 'Kim' }

// ---- The model ------------------------------------------------------------------

test('model: toggles one reaction per person and emoji, in a fixed order, with counts', () => {
  let { reactions, added } = toggleReaction([], '🎉', { name: 'Kim' })
  assert.equal(added, true)
  ;({ reactions } = toggleReaction(reactions, '👍', { name: 'Lee' }))
  ;({ reactions } = toggleReaction(reactions, '👍', { name: 'Kim' }))
  assert.deepEqual(
    reactions.map((entry) => entry.emoji),
    ['👍', '🎉'],
    'REACTIONS order, not the order they came in',
  )
  // The same person again (any case or spacing) takes it away.
  const off = toggleReaction(reactions, '👍', { name: '  kim ' })
  assert.equal(off.added, false)
  assert.deepEqual(publicReactions(off.reactions), [
    { emoji: '👍', count: 1, by: [{ name: 'Lee' }] },
    { emoji: '🎉', count: 1, by: [{ name: 'Kim' }] },
  ])
  // The last one gone: the emoji is gone.
  const empty = toggleReaction(toggleReaction(off.reactions, '🎉', { name: 'Kim' }).reactions, '👍', { name: 'Lee' })
  assert.deepEqual(empty.reactions, [])
})

test('model: accounts are matched by id and never shown; only the fixed set; bad data reads as none', () => {
  const first = toggleReaction([], '❤️', { name: 'Ann', handle: 'ann', user: 'us_1' })
  // A display name change is still the same account.
  const again = toggleReaction(first.reactions, '❤️', { name: 'Ann B', handle: 'ann', user: 'us_1' })
  assert.equal(again.added, false)
  assert.deepEqual(publicReactions(first.reactions), [{ emoji: '❤️', count: 1, by: [{ name: 'Ann', handle: 'ann' }] }])
  assert.ok(!JSON.stringify(publicReactions(first.reactions)).includes('us_1'))
  for (const emoji of ['🍕', '<b>', '', null, '👍🏽'])
    assert.throws(
      () => toggleReaction([], emoji, { name: 'Kim' }),
      (error) => error.code === 'invalid_reaction',
    )
  assert.throws(
    () => toggleReaction([], '👍', { name: '  ' }),
    (error) => error.code === 'invalid_reaction',
  )
  assert.deepEqual(normalizeReactions('nope'), [])
  assert.deepEqual(normalizeReactions([{ emoji: '🍕', by: [{ name: 'x' }] }, { emoji: '👍', by: 'x' }, null]), [])
  assert.deepEqual(normalizeReactions([{ emoji: '👍', by: [{ name: 'A' }, { name: 'a' }, {}] }]), [{ emoji: '👍', by: [{ name: 'A' }] }])
  assert.equal(REACTIONS.length, 6)
  assert.deepEqual(countedReactions(publicReactions(first.reactions)), [{ emoji: '❤️', count: 1, by: [] }])
})

// ---- The local store and API ----------------------------------------------------

test('store: reactions on a comment and a reply, updatedAt kept, no events; older comments read as none', async () => {
  const config = sampleConfig('reactions-store')
  const board = config.boards[0]
  const made = await createComment(config, board, valid, { now: new Date('2026-01-01T00:00:00Z') })
  assert.deepEqual(made.reactions, [])
  assert.equal(made.editedAt, null)
  await addReply(config, board.id, made.id, { body: 'On it', author: 'Lee' }, { now: new Date('2026-01-01T01:00:00Z') })
  const before = getComment(config, board.id, made.id)
  const one = await reactToComment(config, board.id, made.id, { emoji: '👍', author: 'Lee' })
  assert.equal(one.added, true)
  assert.deepEqual(one.comment.reactions, [{ emoji: '👍', count: 1, by: [{ name: 'Lee' }] }])
  assert.equal(one.comment.updatedAt, before.updatedAt, 'a reaction is not work on the comment')
  const onReply = await reactToComment(config, board.id, made.id, { emoji: '🎉', author: 'Kim', replyId: 1 })
  assert.deepEqual(onReply.comment.replies[0].reactions, [{ emoji: '🎉', count: 1, by: [{ name: 'Kim' }] }])
  assert.deepEqual(onReply.comment.reactions, one.comment.reactions)
  // No name: one shared "anonymous", like comments.
  assert.equal((await reactToComment(config, board.id, made.id, { emoji: '👀' })).comment.reactions[1].by[0].name, 'anonymous')
  await assert.rejects(reactToComment(config, board.id, made.id, { emoji: '🍕', author: 'Kim' }), (error) => {
    return error instanceof CommentError && error.statusCode === 400 && error.code === 'invalid_reaction'
  })
  await assert.rejects(reactToComment(config, board.id, made.id, { emoji: '👍', author: 'Kim', replyId: 9 }), /reply does not exist/)
  await assert.rejects(reactToComment(config, board.id, 99, { emoji: '👍', author: 'Kim' }), /comment does not exist/)

  // A comments.json from before reactions and edits.
  const file = commentsFile(config, board.id)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.comments.push({
    ...stored.comments[0],
    id: 7,
    replies: [{ id: 1, author: 'x', body: 'y', createdAt: stored.comments[0].createdAt }],
  })
  delete stored.comments.at(-1).reactions
  fs.writeFileSync(file, JSON.stringify(stored))
  const old = listComments(config, board.id).find((item) => item.id === 7)
  assert.deepEqual(old.reactions, [])
  assert.deepEqual(old.replies[0].reactions, [])

  // Editing the text marks it edited; the same text does not.
  const same = await updateComment(config, board.id, made.id, { body: 'Bigger logo' })
  assert.equal(same.editedAt, null)
  const edited = await updateComment(config, board.id, made.id, { body: 'Bigger logo, please' }, { now: new Date('2026-01-02T00:00:00Z') })
  assert.equal(edited.editedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(edited.reactions.length, 2, 'an edit keeps the reactions')

  // Agents never see reactions: `shapewall comments` and MCP use this shape.
  const report = feedback(config, { boardId: board.id, status: 'all' })
  const text = JSON.stringify(report.comments)
  assert.ok(!text.includes('"reactions"'), 'no reactions in the agent work list')
})

test('API: POST reactions toggles; read-only boards refuse it', async () => {
  const config = sampleConfig('reactions-api')
  const clientDir = tempDir('reactions-api-client')
  const listen = (app) =>
    new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
    })
  const server = await listen(createApp({ config, clientDir }))
  const readOnly = await listen(createApp({ config, clientDir, readOnly: true }))
  try {
    const port = server.address().port
    const created = await request(port, 'POST', '/api/boards/sample/comments', { body: valid })
    const id = created.json.comment.id
    const url = `/api/boards/sample/comments/${id}/reactions`
    const on = await request(port, 'POST', url, { body: { emoji: '❤️', author: 'Kim' } })
    assert.equal(on.status, 200)
    assert.equal(on.json.added, true)
    assert.deepEqual(on.json.comment.reactions, [{ emoji: '❤️', count: 1, by: [{ name: 'Kim' }] }])
    const off = await request(port, 'POST', url, { body: { emoji: '❤️', author: 'Kim' } })
    assert.equal(off.json.added, false)
    assert.deepEqual(off.json.comment.reactions, [])
    assert.equal((await request(port, 'POST', url, { body: { emoji: 'lol', author: 'Kim' } })).json.error.code, 'invalid_reaction')
    assert.equal((await request(port, 'POST', url, { body: { emoji: '👍', replyId: 3 } })).status, 404)
    assert.equal((await request(readOnly.address().port, 'POST', url, { body: { emoji: '👍' } })).status, 403)
  } finally {
    server.close()
    readOnly.close()
  }
})

// ---- Hosted -------------------------------------------------------------------------

let hosted
let owner
let member
let viewer
let other
let ws
let project
let token

async function pushSample(pushToken, label) {
  const config = sampleConfig(`reactions-${label}`)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: pushToken })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

before(async () => {
  hosted = await startHostedServer('reactions-hosted')
  owner = await signUp(hosted, { handle: 'olive', displayName: 'Olive Owner' })
  ws = owner.workspaceId
  member = await signUp(hosted, { handle: 'mel', displayName: 'Mel Member', invite: await invite(owner, ws, 'member') })
  viewer = await signUp(hosted, { handle: 'vic', displayName: 'Vic Viewer', invite: await invite(owner, ws, 'viewer') })
  project = await createProject(owner, ws, 'Site')
  token = await createToken(owner, ws, project.id)
  await pushSample(token, 'main')
  // Someone in another workspace on the same server.
  hosted.rateLimiter.reset()
  await reauth(owner)
  other = await signUp(hosted, { handle: 'bob', displayName: 'Bob Other', invite: await invite(owner, ws, 'viewer') })
  const made = await other.browser.post('/api/workspaces', { name: 'Bob Co' })
  other.workspaceId = made.json.workspace.id
  await other.browser.call('DELETE', `/api/workspaces/${ws}/members/${other.user.id}`)
})
after(() => hosted?.close())

test('hosted: members react by account; viewers, guests, tokens and other workspaces cannot', async () => {
  assert.equal(boardPermissions('member').react, true)
  assert.equal(boardPermissions('viewer').react, false)
  assert.equal(guestPermissions('comment').react, false)
  const base = `/w/${ws}/p/${project.id}/api/boards/sample/comments`
  const comment = (await owner.browser.post(base, { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'Hi' })).json.comment
  assert.deepEqual(comment.reactions, [])
  await owner.browser.post(`${base}/${comment.id}/replies`, { body: 'Reply' })
  const url = `${base}/${comment.id}/reactions`
  const mel = await member.browser.post(url, { emoji: '👍' })
  assert.equal(mel.status, 200)
  assert.deepEqual(mel.json.comment.reactions, [{ emoji: '👍', count: 1, by: [{ name: 'Mel Member', handle: 'mel' }] }])
  assert.ok(!JSON.stringify(mel.json).includes(member.user.id), 'no account ids')
  const olive = await owner.browser.post(url, { emoji: '👍' })
  assert.equal(olive.json.comment.reactions[0].count, 2)
  const onReply = await member.browser.post(url, { emoji: '🎉', replyId: 1 })
  assert.deepEqual(onReply.json.comment.replies[0].reactions, [{ emoji: '🎉', count: 1, by: [{ name: 'Mel Member', handle: 'mel' }] }])
  assert.equal((await member.browser.post(url, { emoji: '👍' })).json.added, false, 'again takes it away')
  assert.equal((await member.browser.post(url, { emoji: 'x' })).json.error.code, 'invalid_reaction')
  assert.equal((await member.browser.post(url, { emoji: '👍', replyId: 5 })).status, 404)

  assert.equal((await viewer.browser.post(url, { emoji: '👍' })).json.error.code, 'read_only')
  // Another workspace's member does not reach this board at all.
  assert.equal((await other.browser.post(url, { emoji: '👍' })).status, 404)
  assert.equal(
    (
      await other.browser.post(`/w/${other.workspaceId}/p/${project.id}/api/boards/sample/comments/${comment.id}/reactions`, {
        emoji: '👍',
      })
    ).status,
    404,
  )
  // Tokens (agents) have no reaction route, and their reads leave reactions out.
  assert.equal((await tokenCall(hosted, token, 'POST', `/api/v1/boards/sample/comments/${comment.id}/reactions`, { body: {} })).status, 404)
  const listed = await tokenCall(hosted, token, 'GET', '/api/v1/boards/sample/comments?status=all')
  assert.equal(listed.status, 200)
  assert.ok(listed.json.comments.some((item) => item.id === comment.id))
  assert.ok(!JSON.stringify(listed.json.comments).includes('"reactions"'))
  // A reaction keeps updated_at.
  const row = hosted.db.prepare('SELECT updated_at, reactions FROM comments WHERE number = ?').get(comment.id)
  assert.equal(row.updated_at, onReply.json.comment.updatedAt)
  assert.ok(
    JSON.parse(row.reactions).every((entry) => entry.by.every((person) => typeof person.user === 'string')),
    'stored by account',
  )

  // A share link guest: counts, never names, and no reacting.
  hosted.rateLimiter.reset()
  await reauth(owner)
  await owner.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })
  const share = await owner.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { mode: 'comment', expiresInDays: 1 })
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post('/api/shares/open', { token: new URL(share.json.url).hash.slice(1), name: 'Gus' })).status, 200)
  const shareApi = (rest) => `/s/${share.json.share.id}/api${rest}`
  const seen = (await guest.get(shareApi('/boards/sample/comments'))).json.comments.find((item) => item.id === comment.id)
  assert.deepEqual(seen.reactions, [{ emoji: '👍', count: 1, by: [] }])
  assert.deepEqual(seen.replies[0].reactions, [{ emoji: '🎉', count: 1, by: [] }])
  assert.ok(!/Mel|Olive/.test(JSON.stringify([seen.reactions, seen.replies[0].reactions])), 'who reacted stays inside the workspace')
  const refused = await guest.post(shareApi(`/boards/sample/comments/${comment.id}/reactions`), { emoji: '👍' })
  assert.equal(refused.json.error.code, 'guest_read_only')
})

test('hosted: an edit marks the comment edited; the migration gives older rows no reactions', async () => {
  const base = `/w/${ws}/p/${project.id}/api/boards/sample/comments`
  const made = (await member.browser.post(base, { pageId: 'home', viewport: 'desktop', x: 9, y: 9, body: 'Typo' })).json.comment
  assert.equal(made.editedAt, null)
  const edited = await member.browser.call('PATCH', `${base}/${made.id}`, { body: { body: 'Typo fixed' } })
  assert.ok(edited.json.comment.editedAt)
  const columns = hosted.db
    .prepare('PRAGMA table_info(comments)')
    .all()
    .map((column) => column.name)
  assert.ok(columns.includes('reactions') && columns.includes('edited_at'))
  hosted.db.prepare("UPDATE comments SET reactions = 'not json' WHERE number = ?").run(made.id)
  const list = (await member.browser.get(base)).json.comments
  assert.deepEqual(list.find((item) => item.id === made.id).reactions, [], 'unreadable reactions read as none')
})

// ---- The public demo -----------------------------------------------------------------

const EXPORT = {
  'data/boards/demo.json': {
    board: { id: 'demo', title: 'Demo', groups: ['App'], pages: [{ id: 'home', title: 'Home', group: 'App' }] },
    viewports: { desktop: { width: 1440, height: 2200 } },
    manifest: { pages: { home: {} } },
    captures: { home: {} },
    versions: {},
    environments: [],
    variants: [],
  },
  'data/boards/demo/comments.json': {
    comments: [
      {
        id: 1,
        pageId: 'home',
        viewport: 'desktop',
        x: 10,
        y: 10,
        body: 'Hi',
        author: 'Robin',
        status: 'open',
        createdAt: '2026-09-30T10:00:00.000Z',
        replies: [{ id: 1, author: 'Jo', body: 'Yes', createdAt: '2026-09-30T11:00:00.000Z' }],
        reactions: [{ emoji: '👍', by: [{ name: 'Jo' }] }],
      },
    ],
  },
}

function demo(role) {
  const state = seedState(Date.parse('2026-10-01T15:00:00.000Z'))
  state.viewAs = role
  const backend = createDemoBackend({
    state,
    location: { project: NOTES_PROJECT },
    now: () => Date.parse('2026-10-01T15:00:00.000Z'),
    loadJson: async (url) => structuredClone(EXPORT[url] ?? Promise.reject(new Error(url))),
    save: () => {},
  })
  return (method, url, body) => backend.handle({ method, path: url, search: '', body })
}

test('demo: export reactions become accounts; members react, viewers cannot, like the server', async () => {
  const member = demo('member')
  const list = await member('GET', '/api/boards/demo/comments')
  assert.deepEqual(list.json.comments[0].reactions, [{ emoji: '👍', count: 1, by: [{ name: 'Jo Park', handle: 'jo' }] }])
  const url = '/api/boards/demo/comments/1/reactions'
  const added = await member('POST', url, { emoji: '👍' })
  assert.equal(added.status, 200)
  assert.equal(added.json.comment.reactions[0].count, 2)
  assert.ok(!JSON.stringify(added.json).includes('us_'), 'no account ids')
  const onReply = await member('POST', url, { emoji: '🚀', replyId: 1 })
  assert.equal(onReply.json.comment.replies[0].reactions[0].emoji, '🚀')
  assert.equal((await member('POST', url, { emoji: '🍕' })).status, 400)
  assert.equal((await demo('viewer')('POST', url, { emoji: '👍' })).status, 403)
  assert.equal((await demo('viewer')('GET', '/api/info')).json.permissions.react, false)
  assert.equal((await member('GET', '/api/info')).json.permissions.react, true)
})
