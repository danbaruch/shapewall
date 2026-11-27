// Writes comments, replies, reactions, journeys, chat threads and a local
// account into an already captured fixture project, using THAT version's own
// store modules (so the files are in that version's shape).
// node gen-data.mjs <pkgRoot> <projectDir>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [pkgRoot, projectDir] = process.argv.slice(2)
const mod = async (rel) => {
  const file = path.join(pkgRoot, 'src', rel)
  return fs.existsSync(file) ? import(pathToFileURL(file).href) : null
}
const log = (...a) => console.log('[gen]', ...a)
const tryStep = async (name, fn) => {
  try {
    const r = await fn()
    log('ok', name)
    return r
  } catch (e) {
    log('skip', name, '-', e.message.split('\n')[0])
    return null
  }
}

process.chdir(projectDir)
const { loadConfig } = await mod('config.js')
const store = await mod('store.js')
const journeys = await mod('journeys.js')
const threads = await mod('agent/threads.js')
const config = loadConfig(path.join(projectDir, 'shapewall.config.json'))
const board = config.boards[0]
// A 2x2 PNG (red), valid for the image sniffers.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGO4o6EBRwzEcQDzAxLBI9OCRQAAAABJRU5ErkJggg==', 'base64')
let at = Date.parse('2026-01-10T10:00:00.000Z')
const now = () => new Date((at += 60_000))

const c1 = await tryStep('comment 1 (anchored, desktop)', () =>
  store.createComment(
    config,
    board,
    {
      pageId: 'home',
      viewport: 'desktop',
      x: 20,
      y: 30,
      body: 'Make the hero card taller.',
      author: 'Owner',
      anchor: { selector: '#hero', text: 'Welcome', dx: 0.5, dy: 0.4 },
    },
    { now: now(), owner: true },
  ),
)
const c2 = await tryStep('comment 2 (phone, by a visitor)', () =>
  store.createComment(
    config,
    board,
    { pageId: 'pricing', viewport: 'phone', x: 50, y: 40, body: 'Plan B reads cramped here.', author: 'Visitor A' },
    { now: now() },
  ),
)
const c3 = await tryStep('comment 3 (with image and drawing)', () =>
  store.createComment(
    config,
    board,
    {
      pageId: 'home',
      viewport: 'phone',
      x: 10,
      y: 70,
      body: 'Button colour like this.',
      author: 'Owner',
      images: [{ name: 'swatch.png', mediaType: 'image/png', data: PNG.toString('base64') }],
      drawing: {
        shapes: [
          {
            tool: 'arrow',
            points: [
              [0.1, 0.1],
              [0.4, 0.4],
            ],
          },
        ],
      },
    },
    { now: now(), owner: true },
  ),
)
const c3b = c3
  ? null
  : await tryStep('comment 3 without media', () =>
      store.createComment(
        config,
        board,
        { pageId: 'home', viewport: 'phone', x: 10, y: 70, body: 'Button colour like this.', author: 'Owner' },
        { now: now() },
      ),
    )
await tryStep('comment 4 (staging environment)', () =>
  store.createComment(
    config,
    board,
    {
      pageId: 'pricing',
      viewport: 'desktop',
      x: 33,
      y: 33,
      body: 'Staging shows the old plan names.',
      author: 'Owner',
      environment: 'staging',
    },
    { now: now(), owner: true },
  ),
)
const c5 = await tryStep('comment 5 (on a variant)', async () => {
  const variants = store.readVariants ? store.readVariants(config, board.id) : []
  if (!variants.length) throw new Error('no variant')
  return store.createComment(
    config,
    board,
    { pageId: `variant:${variants[0].id}`, viewport: 'desktop', x: 5, y: 5, body: 'I like this version.', author: 'Visitor A' },
    { now: now() },
  )
})
if (c1) {
  await tryStep('reply on 1', () =>
    store.addReply(config, board.id, c1.id, { body: 'Agreed, about 40px.', author: 'Visitor A' }, { now: now() }),
  )
  await tryStep('reply on 1 with image', () =>
    store.addReply(
      config,
      board.id,
      c1.id,
      { body: 'Mockup', author: 'Owner', images: [{ name: 'mock.png', mediaType: 'image/png', data: PNG.toString('base64') }] },
      { now: now() },
    ),
  )
  await tryStep('reaction on 1', () => store.reactToComment(config, board.id, c1.id, { emoji: '👍', author: 'Visitor A' }))
  await tryStep('reaction on 1 by owner', () => store.reactToComment(config, board.id, c1.id, { emoji: '👍', author: 'Owner' }))
  await tryStep('reaction on reply', () => store.reactToComment(config, board.id, c1.id, { emoji: '🎉', replyId: 1, author: 'Owner' }))
}
if (c2) {
  await tryStep('resolve 2', () =>
    store.updateComment(config, board.id, c2.id, { status: 'resolved', resolution: 'Spacing fixed.' }, { now: now() }),
  )
  await tryStep('reopen 2', () => store.updateComment(config, board.id, c2.id, { status: 'open' }, { now: now() }))
  await tryStep('resolve 2 again', () =>
    store.updateComment(config, board.id, c2.id, { status: 'resolved', resolution: 'Fixed for real.', fixRef: 'abc1234' }, { now: now() }),
  )
}
void c3b
void c5
// Agent status: a claim the way watch does it, then working.
if (c1 && store.setAgentStatus) {
  await tryStep('agent status queued', () => store.setAgentStatus(config, board.id, c1.id, 'queued', { now: now() }))
}

if (journeys?.createJourney) {
  await tryStep('journey', () =>
    journeys.createJourney(config, board, { name: 'Sign up flow', steps: ['home', 'pricing'] }, { now: now() }),
  )
}

if (threads?.appendUserMessage) {
  const tid = 'chat-0123456789abcdef'
  await tryStep('chat board thread', async () => {
    await threads.appendUserMessage(
      config,
      board.id,
      'board',
      { text: 'What does the pricing page say?', attachments: [] },
      { now: now(), viewer: 'owner' },
    )
    await threads.appendAssistantMessage(config, board.id, 'board', {
      id: 'msg_fixture_a1',
      role: 'assistant',
      text: 'It lists Plan A and Plan B.',
      createdAt: now().toISOString(),
    })
  })
  await tryStep('chat private thread (owner) with an image', async () => {
    await threads.appendUserMessage(
      config,
      board.id,
      tid,
      {
        text: 'Look at this swatch',
        attachments: [{ name: 'swatch.png', mediaType: 'image/png', buffer: PNG, data: PNG.toString('base64') }],
      },
      { now: now(), viewer: 'owner' },
    )
    await threads.appendAssistantMessage(config, board.id, tid, {
      id: 'msg_fixture_a2',
      role: 'assistant',
      text: 'A red square.',
      createdAt: now().toISOString(),
    })
  })
  await tryStep('chat private thread (visitor key)', async () => {
    await threads.appendUserMessage(
      config,
      board.id,
      'chat-fedcba9876543210',
      { text: 'Hello from a visitor', attachments: [] },
      { now: now(), viewer: 'key:00112233445566778899aabbccddeeff' },
    )
  })
  if (c1)
    await tryStep('chat comment thread', async () => {
      await threads.appendUserMessage(
        config,
        board.id,
        `comment-${c1.id}`,
        { text: 'Fix this one please', attachments: [] },
        { now: now(), viewer: 'owner' },
      )
    })
}

// A local account (serve --accounts) with one passkey, when the version has them.
const local = await mod('accounts/local.js')
if (local?.openLocalAccountDatabase) {
  await tryStep('local account', async () => {
    const { db } = await local.openLocalAccountDatabase(config, 'http://localhost:4600')
    db.prepare(
      "INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES ('us_0123456789abcdef01234567', 'owner', 'Owner', 'd2ViYXV0aG4tZml4dHVyZQ', '2026-01-10T09:00:00.000Z')",
    ).run()
    const cols = db
      .prepare('PRAGMA table_info(passkeys)')
      .all()
      .map((c) => c.name)
    const rp = cols.includes('rp_id') ? ', rp_id' : ''
    db.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, nickname, created_at${rp}) VALUES ('Zml4dHVyZS1wYXNza2V5', 'us_0123456789abcdef01234567', ?, 3, '["internal"]', 'Fixture key', '2026-01-10T09:00:00.000Z'${rp ? ", 'localhost'" : ''})`,
    ).run(Buffer.from('fixture-public-key-not-real'))
    db.prepare(
      "INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES ('us_0123456789abcdef01234567', 'fixturehash0001', '2026-01-10T09:00:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, verified_at) VALUES ('fixturesession', 'us_0123456789abcdef01234567', '2026-01-10T09:00:00.000Z', '2026-01-10T09:00:00.000Z', '2026-02-10T09:00:00.000Z', '2026-01-10T09:00:00.000Z')",
    ).run()
    db.close()
  })
}
log('done')
