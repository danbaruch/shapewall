// The contact API: run with `npm test` from website/. A fake notifier and a temporary database; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createContactServer, formatForTelegram, sendToTelegram } from './server.mjs'

const ORIGIN = 'https://shapewall.com'

async function start({ notify, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-contact-'))
  const dbPath = path.join(dir, 'contact.sqlite')
  const sent = []
  const errors = []
  const { server } = createContactServer({
    dbPath,
    env: { CONTACT_ALLOWED_ORIGIN: ORIGIN },
    notify:
      notify ||
      (async (text) => {
        sent.push(text)
        return 'sent'
      }),
    now,
    log: { error: (line) => errors.push(line) },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const rows = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare('SELECT * FROM messages ORDER BY id').all()
    } finally {
      db.close()
    }
  }
  const close = async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { base, sent, errors, rows, close }
}

const valid = (extra = {}) => ({
  kind: 'feature',
  message: 'Please add a dark mode to the board.',
  email: '',
  website: '',
  startedAt: 1_000,
  submittedAt: 9_000,
  ...extra,
})

function post(base, body, { origin = ORIGIN, type = 'application/json', ip = '203.0.113.7', raw } = {}) {
  return fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': type, origin, 'x-real-ip': ip, 'user-agent': 'x'.repeat(300) },
    body: raw ?? JSON.stringify(body),
  })
}

test('a valid submission is stored and the notifier gets the right text', async () => {
  const app = await start()
  try {
    const res = await post(app.base, valid({ email: 'reader@example.com' }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    const [row] = app.rows()
    assert.equal(row.kind, 'feature')
    assert.equal(row.message, 'Please add a dark mode to the board.')
    assert.equal(row.email, 'reader@example.com')
    assert.equal(row.telegram_sent, 1)
    assert.equal(row.user_agent.length, 200)
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(row).includes('203.0.113.7'), 'the raw IP is never stored')
    assert.equal(app.sent.length, 1)
    assert.equal(app.sent[0], 'Shapewall contact (Feature request)\n\nPlease add a dark mode to the board.\n\nEmail: reader@example.com')
  } finally {
    await app.close()
  }
})

test('the Telegram text is plain, truncated, and leaves out a missing email', () => {
  const text = formatForTelegram({ kind: 'bug', message: 'a'.repeat(4000), email: null })
  assert.ok(text.startsWith('Shapewall contact (Bug)\n\n' + 'a'.repeat(3500) + '\n'))
  assert.ok(!text.includes('a'.repeat(3501)))
  assert.doesNotMatch(text, /Email:/)
})

test('sendToTelegram sends plain text to the configured chat and reports failures without the token', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const env = { CONTACT_TELEGRAM_BOT_TOKEN: 'test-token', CONTACT_TELEGRAM_CHAT_ID: '42', CONTACT_TELEGRAM_API_BASE: 'http://stub' }
  assert.equal(await sendToTelegram('hello', env, fetchImpl), 'sent')
  assert.equal(calls[0].url, 'http://stub/bottest-token/sendMessage')
  assert.deepEqual(calls[0].body, { chat_id: '42', text: 'hello', disable_web_page_preview: true })
  assert.equal(await sendToTelegram('hello', {}, fetchImpl), 'not-configured')
  const failing = async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) })
  assert.equal(await sendToTelegram('hello', env, failing), 'failed:401')
})

test('the honeypot is accepted and dropped silently', async () => {
  const app = await start()
  try {
    const res = await post(app.base, valid({ website: 'https://spam.example' }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(app.rows().length, 0)
    assert.equal(app.sent.length, 0)
  } finally {
    await app.close()
  }
})

test('a form sent under 3 seconds is rejected', async () => {
  const app = await start()
  try {
    const res = await post(app.base, valid({ startedAt: 1_000, submittedAt: 3_500 }))
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'too_fast')
    assert.equal((await post(app.base, valid({ startedAt: undefined }))).status, 400)
    assert.equal(app.rows().length, 0)
  } finally {
    await app.close()
  }
})

test('too short, too long and wrongly typed fields are rejected without echoing input', async () => {
  const app = await start()
  try {
    const short = await post(app.base, valid({ message: '  short  ' }))
    assert.equal(short.status, 400)
    assert.deepEqual(await short.json(), { ok: false, error: 'too_short', field: 'message' })
    const long = await post(app.base, valid({ message: 'x'.repeat(4001) }))
    assert.deepEqual(await long.json(), { ok: false, error: 'too_long', field: 'message' })
    assert.equal((await post(app.base, valid({ message: 'y'.repeat(4000) }))).status, 200)
    for (const bad of [{ kind: 'sales' }, { kind: 3 }, { message: ['ten letters!'] }, { email: 'not-an-email' }, { email: 7 }]) {
      const res = await post(app.base, valid(bad))
      assert.equal(res.status, 400, JSON.stringify(bad))
      const text = await res.text()
      assert.ok(!text.includes('sales') && !text.includes('not-an-email'), 'no echo')
    }
    assert.equal(app.rows().length, 1)
  } finally {
    await app.close()
  }
})

test('a wrong or missing Origin is rejected', async () => {
  const app = await start()
  try {
    assert.equal((await post(app.base, valid(), { origin: 'https://evil.example' })).status, 403)
    const res = await fetch(`${app.base}/api/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(valid()),
    })
    assert.equal(res.status, 403)
    assert.equal(app.rows().length, 0)
  } finally {
    await app.close()
  }
})

test('non-JSON bodies, oversized bodies and other methods are rejected', async () => {
  const app = await start()
  try {
    assert.equal((await post(app.base, null, { type: 'application/x-www-form-urlencoded', raw: 'message=hello' })).status, 415)
    assert.equal((await post(app.base, null, { type: 'text/plain', raw: JSON.stringify(valid()) })).status, 415)
    assert.equal((await post(app.base, null, { raw: '{not json' })).status, 400)
    assert.equal((await post(app.base, null, { raw: '[1,2]' })).status, 400)
    const big = await post(app.base, valid({ message: 'z'.repeat(17 * 1024) }))
    assert.equal(big.status, 413)
    const get = await fetch(`${app.base}/api/contact`)
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')
    assert.equal((await fetch(`${app.base}/elsewhere`, { method: 'POST' })).status, 404)
    assert.equal(app.rows().length, 0)
  } finally {
    await app.close()
  }
})

test('the per-IP limit trips at the 6th message in an hour and is kept per sender', async () => {
  let clock = 1_000_000
  const app = await start({ now: () => clock })
  try {
    for (let i = 0; i < 5; i++) {
      clock += 1000
      assert.equal((await post(app.base, valid())).status, 200, `message ${i + 1}`)
    }
    const sixth = await post(app.base, valid())
    assert.equal(sixth.status, 429)
    assert.deepEqual(await sixth.json(), { ok: false, error: 'rate_limited' })
    assert.ok(Number(sixth.headers.get('retry-after')) > 0)
    assert.equal((await post(app.base, valid(), { ip: '198.51.100.9' })).status, 200, 'another sender is not blocked')
    clock += 60 * 60 * 1000
    assert.equal((await post(app.base, valid())).status, 200, 'the hour window slides')
    assert.equal(app.rows().length, 7)
  } finally {
    await app.close()
  }
})

test('a Telegram failure still stores the message and returns ok, and the log has no token', async () => {
  const app = await start({
    notify: async () => {
      throw new Error('network down for bottest-token')
    },
  })
  try {
    const res = await post(app.base, valid())
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    const [row] = app.rows()
    assert.equal(row.telegram_sent, 0)
    assert.equal(app.errors.length, 1)
    assert.ok(!app.errors[0].includes('token'))
  } finally {
    await app.close()
  }
})

test('the health endpoint answers ok and nothing else', async () => {
  const app = await start()
  try {
    const res = await fetch(`${app.base}/api/contact/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    await app.close()
  }
})
