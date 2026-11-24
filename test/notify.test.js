// Notifications: comment events from the store, channel config, and delivery
// to a local stub HTTP server (never a real service).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { ConfigError, normalizeConfig } from '../src/config.js'
import { COMMENT_EVENTS, onCommentEvent } from '../src/events.js'
import { createNotifier, describeChannels, secureApiUrl, signPayload, telegramDetail, testEvent } from '../src/notify/index.js'
import { deprecation, missingEnv, telegramChatId } from '../src/notify/config.js'
import { TELEGRAM_TEXT_MAX, commentLink, discordMessage, publicLink, slackMessage, telegramMessage } from '../src/notify/messages.js'
import { addReply, createComment, setAgentStatus, updateComment } from '../src/store.js'
import { main } from '../src/cli.js'
import { checkNotifications, runDoctor } from '../src/doctor.js'
import { createApp } from '../src/server/app.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const SECRET = 'whsec-test-0123456789'
// A made-up bot token in the shape @BotFather hands out.
const TG_TOKEN = '123456:TEST-not-a-real-token-0123456789'

// A stub HTTP server: records every request and answers from `responses`
// (a list of { status, headers, delay }, then 200 for everything after).
async function stub(responses = []) {
  const requests = []
  const queue = [...responses]
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, path: req.url, headers: req.headers, body, json: body ? JSON.parse(body) : null })
      const answer = queue.shift() || { status: 200 }
      setTimeout(() => {
        res.writeHead(answer.status, { 'Content-Type': 'application/json', ...(answer.headers || {}) })
        res.end('{}')
      }, answer.delay || 0)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

function makeConfig(name, notifications, env = {}) {
  const dir = tempDir(name)
  return normalizeConfig({ ...structuredClone(SAMPLE), notifications }, { dir, file: path.join(dir, 'shapewall.config.json'), env })
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const anchorless = { pageId: 'home', viewport: 'desktop', x: 0.5, y: 0.5, author: 'Robin' }

test('events: the store emits created, mentioned, replied, edits, resolve, reopen and agent status', async () => {
  const config = makeConfig('notify-events', undefined)
  const board = config.boards[0]
  const seen = []
  const off = onCommentEvent((event) => seen.push(event))
  // A broken listener never fails the change.
  const offBroken = onCommentEvent(() => {
    throw new Error('listener bug')
  })
  try {
    const comment = await createComment(config, board, { ...anchorless, body: 'Hero is too tall, @Sam and @agent please look' })
    assert.deepEqual(
      seen.map((event) => [event.type, event.handle]),
      [
        ['comment.created', undefined],
        ['comment.mentioned', 'sam'],
        ['comment.mentioned', 'agent'],
      ],
    )
    assert.equal(seen[0].boardId, 'sample')
    assert.equal(seen[0].comment.id, comment.id)
    assert.equal(seen[0].actor, 'Robin')
    assert.ok(seen[0].id && seen[0].at)

    seen.length = 0
    await addReply(config, board.id, comment.id, { body: 'On it, cc @lee', author: 'agent' })
    assert.deepEqual(
      seen.map((event) => [event.type, event.handle, event.reply?.author]),
      [
        ['comment.replied', undefined, 'agent'],
        ['comment.mentioned', 'lee', 'agent'],
      ],
    )

    seen.length = 0
    await updateComment(config, board.id, comment.id, { body: 'Hero is too tall, @Sam and @agent please look, @kim too' })
    assert.deepEqual(
      seen.map((event) => [event.type, event.handle]),
      [['comment.mentioned', 'kim']],
    )

    seen.length = 0
    await setAgentStatus(config, board.id, comment.id, 'working')
    await setAgentStatus(config, board.id, comment.id, 'working') // no change, no event
    await updateComment(config, board.id, comment.id, { status: 'resolved', resolution: 'Shorter now' })
    await updateComment(config, board.id, comment.id, { status: 'open' })
    assert.deepEqual(
      seen.map((event) => event.type),
      // Resolving a comment an agent was working on sets its agent status to done.
      [
        'comment.agent_status_changed',
        'comment.resolved',
        'comment.agent_status_changed',
        'comment.reopened',
        'comment.agent_status_changed',
      ],
    )
    assert.deepEqual(seen[0].previous, { agentStatus: null })
    assert.equal(seen[0].agentStatus, 'working')
    // Reopening clears the agent status: that is a status change too.
    assert.deepEqual([seen[2].previous, seen[2].agentStatus], [{ agentStatus: 'working' }, 'done'])
    assert.deepEqual(seen[4].previous, { agentStatus: 'done' })
    assert.equal(seen[4].agentStatus, null)
    assert.equal(COMMENT_EVENTS.length, 6)
  } finally {
    off()
    offBroken()
  }
})

test('webhook channels require operator-configured destinations and signing variables', () => {
  const config = (overrides) => makeConfig('notify-settings', { channels: [{ type: 'webhook', ...overrides }] })
  assert.throws(() => config({ url: 'https://example.com/' }), /urlEnv/)
  assert.throws(() => config({ secretEnv: 'OTHER_SIGNING_KEY' }), /SHAPEWALL_WEBHOOK_SECRET/)
  assert.throws(() => config({ urlEnv: 'OTHER_DESTINATION' }), /SHAPEWALL_WEBHOOK_URL/)
})

test('config: channels, defaults, people and env-only channels; secrets only by name', () => {
  const config = makeConfig('notify-config', {
    boardUrl: 'https://shapewall.example.com/',
    retries: 2,
    people: { '@Sam': { email: 'sam@example.com', slack: 'U012AB3CD', discord: '123456789012' } },
    channels: [
      { id: 'hooks', type: 'webhook', urlEnv: 'SHAPEWALL_WEBHOOK_URL', events: ['created', 'comment.resolved'] },
      { type: 'slack', boards: ['sample'] },
      { id: 'mail', type: 'email', from: 'Shapewall <reviews@example.com>', to: 'team@example.com', fallback: 'outbox' },
    ],
  })
  const [hooks, slack, mail] = config.notifications.channels
  assert.equal(config.notifications.boardUrl, 'https://shapewall.example.com/')
  assert.equal(config.notifications.retries, 2)
  assert.deepEqual(config.notifications.people.sam, { email: 'sam@example.com', slack: 'U012AB3CD', discord: '123456789012' })
  assert.deepEqual(hooks.events, ['comment.created', 'comment.resolved'])
  assert.equal(hooks.secretEnv, 'SHAPEWALL_WEBHOOK_SECRET')
  assert.equal(slack.id, 'slack')
  assert.equal(slack.urlEnv, 'SHAPEWALL_SLACK_WEBHOOK_URL')
  assert.ok(!slack.events.includes('comment.mentioned'), 'chat channels ping inside the message, not twice')
  assert.deepEqual(mail.events, ['comment.mentioned'])
  assert.deepEqual(mail.to, ['team@example.com'])
  assert.equal(mail.apiKeyEnv, 'RESEND_API_KEY')
  // The email key may come from RESEND_API_KEY or a SHAPEWALL_ variable, never another tool's secret.
  const email = (apiKeyEnv) => ({ channels: [{ type: 'email', from: 'reviews@example.com', to: 'team@example.com', apiKeyEnv }] })
  assert.equal(makeConfig('notify-key', email('SHAPEWALL_EMAIL_KEY')).notifications.channels[0].apiKeyEnv, 'SHAPEWALL_EMAIL_KEY')
  for (const name of [
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'SHAPEWALL_',
    'XSHAPEWALL_KEY',
    'RESEND_API_KEY_2',
    'SHAPEWALL_GITHUB_TOKEN',
    'SHAPEWALL_AGENT_API_KEY',
  ]) {
    assert.throws(
      () => makeConfig('notify-key-bad', email(name)),
      (error) =>
        error instanceof ConfigError && /apiKeyEnv: RESEND_API_KEY or a variable whose name starts with SHAPEWALL_/.test(error.message),
      name,
    )
  }

  const problems = (notifications) => {
    try {
      makeConfig('notify-bad', notifications)
      return []
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      return error.problems
    }
  }
  const bad = problems({
    channels: [
      { type: 'slack', url: 'https://hooks.slack.com/services/T/B/x' },
      { type: 'webhook', secret: 'plain' },
      { type: 'email', apiKey: 'plain', from: 'nope' },
      { type: 'carrier-pigeon' },
      { id: 'x', type: 'discord', urlEnv: 'lower-case', events: ['exploded'], boards: ['nope'] },
    ],
    people: { robin: { slack: 'not-an-id' } },
  })
  const all = bad.join('\n')
  assert.match(all, /channels\[0\]\.url: set the delivery URL/)
  assert.match(all, /channels\[1\]\.secret: never put secrets in the config/)
  assert.match(all, /channels\[2\]\.apiKey: never put secrets/)
  assert.match(all, /channels\[2\]\.from/)
  assert.match(all, /channels\[3\]\.type/)
  assert.match(all, /channels\[4\]\.urlEnv/)
  assert.match(all, /channels\[4\]\.events: unknown event "exploded"/)
  assert.match(all, /channels\[4\]\.boards/)
  assert.match(all, /people\.robin\.slack/)

  // No channel list: channels come from the environment, by name only.
  const env = {
    SHAPEWALL_SLACK_WEBHOOK_URL: 'https://hooks.slack.example/secret-path',
    RESEND_API_KEY: 're_secret',
    SHAPEWALL_EMAIL_FROM: 'r@example.com',
  }
  const fromEnv = makeConfig('notify-env', undefined, env)
  assert.deepEqual(
    fromEnv.notifications.channels.map((channel) => [channel.id, channel.fromEnv]),
    [
      ['slack', true],
      ['email', true],
    ],
  )
  const serialized = JSON.stringify(fromEnv)
  assert.ok(!serialized.includes('secret-path') && !serialized.includes('re_secret'), 'no secret value in the config object')
  assert.deepEqual(makeConfig('notify-none', undefined, {}).notifications.channels, [])
})

test('messages: deep links, Slack and Discord escaping, and pings only for mapped people', () => {
  const config = makeConfig('notify-messages', {
    people: { sam: { slack: 'U012AB3CD', discord: '123456789012' } },
    channels: [{ type: 'slack' }],
  })
  const comment = {
    id: 7,
    pageId: 'pricing',
    viewport: 'phone',
    author: 'Robin',
    body: '<!channel> @everyone @sam & @lee: price <b>wrong</b>',
    replies: [],
  }
  assert.equal(
    commentLink(config, 'https://wall.example.com/team/', 'sample', comment),
    'https://wall.example.com/team/?board=sample&c=7&filter=all&vp=phone',
  )
  const event = { id: 'e1', type: 'comment.created', at: '2026-01-01T00:00:00.000Z', boardId: 'sample', commentId: 7, comment }
  const slack = slackMessage(config, event, 'https://wall.example.com/').text
  assert.match(slack, /^\*Robin commented on Pricing \(phone\)\*/)
  assert.ok(slack.includes('&lt;!channel&gt;'), 'no channel ping from comment text')
  assert.ok(slack.includes('<@U012AB3CD>'), 'mapped person pinged')
  assert.ok(slack.includes('@lee'), 'unmapped stays plain text')
  assert.ok(slack.includes('&amp;') && slack.includes('&lt;b&gt;'))
  assert.ok(slack.includes('<https://wall.example.com/?board=sample&c=7&filter=all&vp=phone|Open on the board>'))

  const discord = discordMessage(config, { ...event, type: 'comment.mentioned', handle: 'sam' }, 'https://wall.example.com/')
  assert.deepEqual(discord.allowed_mentions, { parse: [], users: ['123456789012'] })
  assert.match(discord.content, /^<@123456789012> \*\*@\u200bsam, you were mentioned on #7/)
  assert.ok(discord.content.includes('@\u200beveryone'))
  assert.ok(discord.content.includes('[Open on the board](https://wall.example.com/?board=sample&c=7&filter=all&vp=phone)'))
})

test('config: the pre-1.0 event name comment.status_changed still filters, with one warning', () => {
  const warned = []
  const write = deprecation.write
  deprecation.write = (line) => warned.push(line)
  deprecation.warned.clear()
  try {
    const config = makeConfig('notify-alias', {
      channels: [
        { id: 'a', type: 'webhook', events: ['comment.status_changed', 'created'] },
        { id: 'b', type: 'webhook', urlEnv: 'SHAPEWALL_WEBHOOK_URL', events: ['status_changed', 'agent_status_changed'] },
      ],
    })
    const [a, b] = config.notifications.channels
    assert.deepEqual(a.events, ['comment.agent_status_changed', 'comment.created'])
    assert.deepEqual(b.events, ['comment.agent_status_changed'])
    assert.equal(warned.length, 1, 'once per process')
    assert.match(warned[0], /"comment\.status_changed" is now "comment\.agent_status_changed"/)
    assert.ok(COMMENT_EVENTS.includes('comment.agent_status_changed'))
    assert.ok(!COMMENT_EVENTS.includes('comment.status_changed'))
  } finally {
    deprecation.write = write
  }
})

test('delivery: signed webhook, Slack, Discord and Resend email to a stub server, with mention routing', async () => {
  const server = await stub()
  const env = {
    SHAPEWALL_WEBHOOK_URL: `${server.base}/hook`,
    SHAPEWALL_WEBHOOK_SECRET: SECRET,
    SHAPEWALL_SLACK_WEBHOOK_URL: `${server.base}/slack/T000/B000/secret-token`,
    SHAPEWALL_DISCORD_WEBHOOK_URL: `${server.base}/discord`,
    RESEND_API_KEY: 're_test_key',
    SHAPEWALL_RESEND_URL: `${server.base}/resend`,
  }
  const config = makeConfig('notify-deliver', {
    boardUrl: 'https://wall.example.com/',
    people: { sam: { email: 'sam@example.com', slack: 'U012AB3CD' } },
    channels: [
      { type: 'webhook', events: ['all'] },
      { type: 'slack' },
      { type: 'discord', events: ['resolved'] },
      { type: 'email', from: 'Shapewall <reviews@example.com>' },
    ],
  })
  const logs = []
  const notifier = createNotifier(config, { env, log: (line) => logs.push(line), backoffMs: 5 }).start()
  try {
    const board = config.boards[0]
    const comment = await createComment(config, board, { ...anchorless, body: 'Please check, @sam (and @nobody)' })
    await updateComment(config, board.id, comment.id, { status: 'resolved', fixRef: 'https://github.com/acme/site/pull/9' })
    assert.equal(await notifier.flush(5000), true)
    const by = (prefix) => server.requests.filter((item) => item.path.startsWith(prefix))

    // Webhook: every event, signed over "timestamp.body".
    const hooks = by('/hook')
    assert.deepEqual(
      hooks.map((item) => item.json.type),
      ['comment.created', 'comment.mentioned', 'comment.mentioned', 'comment.resolved'],
    )
    for (const hook of hooks) {
      const { 'x-shapewall-timestamp': timestamp, 'x-shapewall-signature': signature } = hook.headers
      const expected = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${hook.body}`).digest('hex')}`
      assert.equal(signature, expected)
      assert.equal(signature, signPayload(SECRET, timestamp, hook.body))
      assert.equal(hook.headers['x-shapewall-event'], hook.json.type)
      assert.equal(hook.headers['x-shapewall-delivery'], hook.json.id)
    }
    assert.equal(hooks[0].json.url, `https://wall.example.com/?board=sample&c=${comment.id}&filter=all`)
    assert.equal(hooks[0].json.version, 1)
    assert.deepEqual(hooks[0].json.board, { id: 'sample', title: board.title, baseUrl: board.baseUrl })
    assert.equal(hooks[0].json.comment.pageTitle, 'Home')
    assert.equal(hooks[1].json.handle, 'sam')
    assert.ok(!hooks[1].body.includes('sam@example.com'), 'people by handle only')
    assert.equal(hooks[3].json.comment.fixRef, 'https://github.com/acme/site/pull/9')

    // Slack: created and resolved (its defaults), mapped mention pinged.
    const slack = by('/slack')
    assert.equal(slack.length, 2)
    assert.ok(slack[0].json.text.includes('<@U012AB3CD>'))
    // Discord: only resolved.
    assert.equal(by('/discord').length, 1)
    assert.match(by('/discord')[0].json.content, /was resolved/)
    // Email: only the mention of a mapped person, sent to them.
    const mail = by('/resend')
    assert.equal(mail.length, 1)
    assert.deepEqual(mail[0].json.to, ['sam@example.com'])
    assert.equal(mail[0].headers.authorization, 'Bearer re_test_key')
    assert.match(mail[0].json.subject, /^\[Shapewall\] @sam, you were mentioned on #1/)
    assert.ok(mail[0].json.html.includes(`https://wall.example.com/?board=sample&amp;c=${comment.id}&amp;filter=all`))
    // @nobody has no email: skipped, said once, no secrets in any log line.
    assert.ok(logs.some((line) => /email skipped comment\.mentioned #1: no email for @nobody/.test(line)))
    for (const line of logs) {
      for (const secret of [SECRET, 'secret-token', 're_test_key', server.base]) assert.ok(!line.includes(secret), `log leaks: ${line}`)
    }
  } finally {
    notifier.stop()
    await server.close()
  }
})

test('delivery: retries 5xx and 429 with backoff, gives up on 4xx, never blocks the change', async () => {
  const server = await stub([{ status: 500 }, { status: 429, headers: { 'Retry-After': '0' } }, { status: 200, delay: 0 }, { status: 400 }])
  const env = { SHAPEWALL_WEBHOOK_URL: `${server.base}/hook`, SHAPEWALL_WEBHOOK_SECRET: SECRET }
  const config = makeConfig('notify-retry', { retries: 3, channels: [{ type: 'webhook', events: ['created'] }] })
  const logs = []
  const notifier = createNotifier(config, { env, log: (line) => logs.push(line), backoffMs: 5 }).start()
  try {
    const board = config.boards[0]
    await createComment(config, board, { ...anchorless, body: 'First' })
    assert.equal(server.requests.length, 0, 'the change returned before anything was sent')
    await notifier.flush(5000)
    assert.equal(server.requests.length, 3, '500, 429, then 200')
    assert.equal(new Set(server.requests.map((item) => item.json.id)).size, 1, 'the same delivery each time')
    assert.ok(logs.some((line) => /webhook sent comment\.created #1/.test(line)))

    await createComment(config, board, { ...anchorless, body: 'Second' })
    await notifier.flush(5000)
    assert.equal(server.requests.length, 4, 'a 400 is final')
    assert.ok(logs.some((line) => /webhook failed comment\.created #2 after 1 attempt: HTTP 400/.test(line)))

    // A slow endpoint does not hold up the API.
    const slow = await stub([{ status: 200, delay: 600 }])
    const slowNotifier = createNotifier(config, { env: { ...env, SHAPEWALL_WEBHOOK_URL: `${slow.base}/hook` } }).start()
    try {
      const started = Date.now()
      await createComment(config, board, { ...anchorless, body: 'Third' })
      assert.ok(Date.now() - started < 300)
      await slowNotifier.flush(5000)
      assert.equal(slow.requests.length, 1)
    } finally {
      slowNotifier.stop()
      await slow.close()
    }
  } finally {
    notifier.stop()
    await server.close()
  }
})

test('delivery: network errors retry and log no URL; unready channels and board filters skip', async () => {
  const dead = await stub()
  await dead.close() // a closed port: connection refused
  const config = makeConfig('notify-dead', {
    retries: 1,
    channels: [
      {
        id: 'dead',
        type: 'webhook',
        urlEnv: 'SHAPEWALL_WEBHOOK_DEAD_URL',
        secretEnv: 'SHAPEWALL_WEBHOOK_DEAD_SECRET',
        events: ['created'],
      },
      { id: 'unready', type: 'slack', events: ['created'] },
      {
        id: 'other-board',
        type: 'webhook',
        urlEnv: 'SHAPEWALL_WEBHOOK_DEAD_URL',
        secretEnv: 'SHAPEWALL_WEBHOOK_DEAD_SECRET',
        events: ['created'],
        boards: ['sample'],
      },
    ],
  })
  config.notifications.channels[2].boards = ['elsewhere']
  const logs = []
  const env = { SHAPEWALL_WEBHOOK_DEAD_URL: `${dead.base}/hook/secret-path`, SHAPEWALL_WEBHOOK_DEAD_SECRET: SECRET }
  const notifier = createNotifier(config, { env, log: (line) => logs.push(line), backoffMs: 5 }).start()
  try {
    await createComment(config, config.boards[0], { ...anchorless, body: 'Hello' })
    await notifier.flush(5000)
    assert.ok(
      logs.some((line) => /dead failed comment\.created #1 after 2 attempts: network error \(ECONNREFUSED\)/.test(line)),
      logs.join('\n'),
    )
    assert.ok(logs.some((line) => /unready skipped comment\.created #1: set SHAPEWALL_SLACK_WEBHOOK_URL/.test(line)))
    assert.ok(!logs.some((line) => line.startsWith('notify: other-board')))
    assert.ok(!logs.join('\n').includes('secret-path'))
  } finally {
    notifier.stop()
  }
})

test('email: the outbox fallback writes .eml files when there is no API key, and is off by default', async () => {
  const config = makeConfig('notify-outbox', {
    people: { sam: { email: 'sam@example.com' } },
    channels: [
      { id: 'mail', type: 'email', from: 'reviews@example.com', fallback: 'outbox' },
      { id: 'off', type: 'email', from: 'reviews@example.com' },
    ],
  })
  const logs = []
  const notifier = createNotifier(config, { env: {}, log: (line) => logs.push(line) }).start()
  try {
    await createComment(config, config.boards[0], { ...anchorless, body: '@sam look' })
    await notifier.flush(5000)
    const dir = path.join(config.outputDir, 'notifications', 'outbox')
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    const eml = fs.readFileSync(path.join(dir, files[0]), 'utf8')
    assert.match(eml, /^From: reviews@example\.com\r\nTo: sam@example\.com\r\nSubject: \[Shapewall\] @sam, you were mentioned/)
    assert.match(eml, /Open on the board: http:\/\/127\.0\.0\.1:4600\/\?board=sample&c=1&filter=all/)
    assert.ok(logs.some((line) => /off skipped comment\.mentioned #1: set RESEND_API_KEY/.test(line)))
  } finally {
    notifier.stop()
  }
})

test('API: a comment posted to the server is notified with its deep link, after the response', async () => {
  const hook = await stub()
  const env = { SHAPEWALL_WEBHOOK_URL: `${hook.base}/hook`, SHAPEWALL_WEBHOOK_SECRET: SECRET }
  const config = makeConfig('notify-api', { channels: [{ type: 'webhook', events: ['created', 'replied'] }] })
  const app = createApp({ config, clientDir: tempDir('notify-api-client') })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  const port = server.address().port
  const notifier = createNotifier(config, { env, boardUrl: `http://127.0.0.1:${port}/`, backoffMs: 5 }).start()
  try {
    const created = await request(port, 'POST', '/api/boards/sample/comments', {
      body: { ...anchorless, viewport: 'phone', body: 'Tap target too small' },
    })
    assert.equal(created.status, 201)
    const id = created.json.comment.id
    const replied = await request(port, 'POST', `/api/boards/sample/comments/${id}/replies`, { body: { body: 'Fixed', author: 'agent' } })
    assert.equal(replied.status, 201)
    await notifier.flush(5000)
    await until(() => hook.requests.length === 2)
    assert.deepEqual(
      hook.requests.map((item) => item.json.type),
      ['comment.created', 'comment.replied'],
    )
    assert.equal(hook.requests[0].json.url, `http://127.0.0.1:${port}/?board=sample&c=${id}&filter=all&vp=phone`)
    assert.equal(hook.requests[1].json.reply.body, 'Fixed')
  } finally {
    notifier.stop()
    server.close()
    await hook.close()
  }
})

test('CLI: notify list and notify test, comment changes from the CLI notify, doctor reports channels', async () => {
  const hook = await stub([{ status: 200 }, { status: 503 }, { status: 503 }])
  const dir = tempDir('notify-cli')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...SAMPLE,
      notifications: {
        retries: 1,
        people: { sam: { email: 'sam@example.com' } },
        channels: [
          {
            id: 'hooks',
            type: 'webhook',
            urlEnv: 'SHAPEWALL_WEBHOOK_TEST_URL',
            secretEnv: 'SHAPEWALL_WEBHOOK_TEST_SECRET',
            events: ['resolved'],
          },
          { id: 'team', type: 'slack', urlEnv: 'SHAPEWALL_SLACK_WEBHOOK_TEST_URL' },
        ],
      },
    }),
  )
  const saved = { ...process.env }
  process.env.SHAPEWALL_WEBHOOK_TEST_URL = `${hook.base}/hook`
  process.env.SHAPEWALL_WEBHOOK_TEST_SECRET = SECRET
  delete process.env.SHAPEWALL_SLACK_WEBHOOK_TEST_URL
  const run = async (argv) => {
    const lines = []
    const errors = []
    const code = await main(argv, { out: (line) => lines.push(line), err: (line) => errors.push(line) })
    return { code, text: lines.join('\n'), errors: errors.join('\n') }
  }
  try {
    const list = await run(['notify', 'list', '--config', file])
    assert.match(list.text, /^hooks {2}webhook\n {2}events: resolved\n {2}ready$/m)
    assert.match(
      list.text,
      /^team {2}slack\n {2}events: created, replied, resolved, reopened\n {2}not ready: set SHAPEWALL_SLACK_WEBHOOK_TEST_URL$/m,
    )
    assert.match(list.text, /People mapped for mentions: @sam/)
    const json = JSON.parse((await run(['notify', 'list', '--config', file, '--json'])).text)
    assert.deepEqual(
      json.channels.map((item) => [item.id, item.ready]),
      [
        ['hooks', true],
        ['team', false],
      ],
    )
    assert.ok(!JSON.stringify(json).includes(hook.base), 'no URLs or secrets in the listing')

    const sent = await run(['notify', 'test', 'hooks', '--config', file])
    assert.equal(sent.code, 0)
    assert.match(sent.text, /Sent a test message to hooks \(HTTP 200\)/)
    assert.equal(hook.requests[0].json.type, 'notify.test')
    const failed = await run(['notify', 'test', 'hooks', '--config', file])
    assert.equal(failed.code, 1)
    assert.match(failed.text, /Could not send to hooks: HTTP 503 \(after 2 attempts\)/)
    const unready = await run(['notify', 'test', 'team', '--config', file])
    assert.equal(unready.code, 1)
    assert.match(unready.text, /set SHAPEWALL_SLACK_WEBHOOK_TEST_URL/)
    await assert.rejects(run(['notify', 'test', 'nope', '--config', file]), /have: hooks, team/)

    // `comments resolve` waits for its message before exiting.
    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig(file)
    const comment = await createComment(config, config.boards[0], { ...anchorless, body: 'Fix me' })
    const resolved = await run(['comments', 'resolve', String(comment.id), '--config', file])
    assert.equal(resolved.code, 0)
    assert.equal(hook.requests.at(-1).json.type, 'comment.resolved')
    assert.match(resolved.errors, /hooks sent comment\.resolved/)

    const doctor = await runDoctor({ configFile: file, port: 0, launch: false, chromium: { executablePath: () => process.execPath } })
    const check = doctor.checks.find((item) => item.name === 'notifications')
    assert.equal(check.status, 'warn')
    assert.match(check.message, /hooks \(webhook\), team \(slack\); 1 person mapped for mentions; not ready: team/)
    assert.match(check.fix, /Set SHAPEWALL_SLACK_WEBHOOK_TEST_URL for team/)
    assert.ok(!JSON.stringify(doctor).includes(SECRET))
  } finally {
    for (const key of ['SHAPEWALL_WEBHOOK_TEST_URL', 'SHAPEWALL_WEBHOOK_TEST_SECRET', 'SHAPEWALL_SLACK_WEBHOOK_TEST_URL']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await hook.close()
  }
})

test('telegram: config, defaults, people, env-only channel and secrets only by name', () => {
  const config = makeConfig('notify-telegram-config', {
    people: { sam: { telegram: '123456789' }, lee: { telegram: 42 } },
    channels: [
      { id: 'tg', type: 'telegram', chatId: -1001234567890 },
      { id: 'tg-news', type: 'telegram', chatId: '@shapewall_news', tokenEnv: 'SHAPEWALL_TELEGRAM_NEWS_BOT_TOKEN', events: ['all'] },
    ],
  })
  const [tg, news] = config.notifications.channels
  assert.equal(tg.tokenEnv, 'SHAPEWALL_TELEGRAM_BOT_TOKEN')
  assert.equal(tg.chatId, '-1001234567890')
  assert.deepEqual(tg.events, ['comment.created', 'comment.replied', 'comment.resolved', 'comment.reopened'])
  assert.equal(news.chatId, '@shapewall_news')
  assert.equal(news.events.length, 6)
  assert.deepEqual(config.notifications.people.sam, { telegram: '123456789' })
  assert.deepEqual(config.notifications.people.lee, { telegram: '42' })
  assert.deepEqual(missingEnv(tg, {}), ['SHAPEWALL_TELEGRAM_BOT_TOKEN'])
  assert.deepEqual(missingEnv(tg, { SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN }), [])

  const problems = (notifications) => {
    try {
      makeConfig('notify-telegram-bad', notifications)
      return ''
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      return error.problems.join('\n')
    }
  }
  const bad = problems({
    channels: [
      { type: 'telegram', chatId: '1', token: TG_TOKEN },
      { type: 'telegram', chatId: '1', botToken: TG_TOKEN },
      { type: 'telegram', chatId: '1', tokenEnv: 'GITHUB_TOKEN' },
      { type: 'telegram', chatIdEnv: 'MY_CHAT' },
      { type: 'telegram', chatId: 'not a chat' },
      { type: 'telegram', chatId: '1', chatIdEnv: 'SHAPEWALL_TELEGRAM_CHAT_ID' },
    ],
    people: { robin: { telegram: '@robin' } },
  })
  assert.match(bad, /channels\[0\]\.token: never put secrets in the config; set tokenEnv/)
  assert.match(bad, /channels\[1\]\.botToken: never put secrets in the config; set tokenEnv/)
  assert.match(bad, /channels\[2\]\.tokenEnv: use SHAPEWALL_TELEGRAM_BOT_TOKEN or SHAPEWALL_TELEGRAM_<NAME>_BOT_TOKEN/)
  assert.match(bad, /channels\[3\]\.chatIdEnv: use SHAPEWALL_TELEGRAM_CHAT_ID or SHAPEWALL_TELEGRAM_<NAME>_CHAT_ID/)
  assert.match(bad, /channels\[4\]\.chatId/)
  assert.match(bad, /channels\[5\]: set chatIdEnv or chatId, not both/)
  assert.match(bad, /people\.robin\.telegram: a Telegram user id/)
  assert.ok(!bad.includes(TG_TOKEN), 'the token is never echoed back')
  // The email channel may not read the Telegram token.
  assert.match(
    problems({ channels: [{ type: 'email', from: 'r@example.com', apiKeyEnv: 'SHAPEWALL_TELEGRAM_BOT_TOKEN' }] }),
    /apiKeyEnv: RESEND_API_KEY or a variable/,
  )

  // Off by default; from the environment with a token and a chat id.
  assert.deepEqual(makeConfig('notify-telegram-none', undefined, {}).notifications.channels, [])
  const env = { SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN, SHAPEWALL_TELEGRAM_CHAT_ID: '-100987654321' }
  const fromEnv = makeConfig('notify-telegram-env', undefined, env)
  const [channel] = fromEnv.notifications.channels
  assert.deepEqual(
    [channel.id, channel.type, channel.chatIdEnv, channel.fromEnv],
    ['telegram', 'telegram', 'SHAPEWALL_TELEGRAM_CHAT_ID', true],
  )
  assert.equal(telegramChatId(channel, env), '-100987654321')
  assert.ok(!JSON.stringify(fromEnv).includes('-100987654321'), 'the destination stays in the environment')
  assert.ok(!JSON.stringify(fromEnv).includes(TG_TOKEN), 'no token in the config object')
  // A token without a usable chat id: listed, not ready.
  const noChat = makeConfig('notify-telegram-nochat', undefined, { SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN }).notifications.channels[0]
  assert.deepEqual(missingEnv(noChat, { SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN }), ['SHAPEWALL_TELEGRAM_CHAT_ID'])
})

test('telegram: the chat comes from the environment (chatIdEnv); a chatId in the config is flagged by notify list and doctor', () => {
  const config = makeConfig('notify-telegram-chatenv', {
    channels: [
      { id: 'phones', type: 'telegram' },
      { id: 'ops', type: 'telegram', tokenEnv: 'SHAPEWALL_TELEGRAM_OPS_BOT_TOKEN', chatIdEnv: 'SHAPEWALL_TELEGRAM_OPS_CHAT_ID' },
      { id: 'inline', type: 'telegram', chatId: '-100123' },
    ],
  })
  const [phones, ops, inline] = config.notifications.channels
  assert.equal(phones.chatIdEnv, 'SHAPEWALL_TELEGRAM_CHAT_ID')
  assert.equal(phones.chatId, undefined)
  assert.equal(ops.chatIdEnv, 'SHAPEWALL_TELEGRAM_OPS_CHAT_ID')
  const env = {
    SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN,
    SHAPEWALL_TELEGRAM_OPS_BOT_TOKEN: TG_TOKEN,
    SHAPEWALL_TELEGRAM_CHAT_ID: '@shapewall_news',
    SHAPEWALL_TELEGRAM_OPS_CHAT_ID: 'not a chat',
  }
  assert.equal(telegramChatId(phones, env), '@shapewall_news')
  assert.deepEqual(missingEnv(phones, env), [])
  assert.deepEqual(missingEnv(ops, env), ['SHAPEWALL_TELEGRAM_OPS_CHAT_ID'], 'an unusable id is not ready')
  const listed = describeChannels(config, env)
  assert.deepEqual(
    listed.map((item) => item.warnings.length),
    [0, 0, 1],
  )
  assert.match(listed[2].warnings[0], /chat id is written in the config/)
  assert.equal(inline.chatIdInConfig, true)
  const doctor = checkNotifications(config, env)
  assert.match(doctor.message + ' ' + (doctor.fix || ''), /inline: the Telegram chat id is written in the config/)
})

test('telegram: SHAPEWALL_TELEGRAM_API_URL must be https unless it is this machine', async () => {
  assert.equal(secureApiUrl('https://api.telegram.org'), true)
  assert.equal(secureApiUrl('http://127.0.0.1:8081'), true)
  assert.equal(secureApiUrl('http://localhost:8081/x'), true)
  assert.equal(secureApiUrl('http://[::1]:8081'), true)
  assert.equal(secureApiUrl('http://api.telegram.org'), false)
  assert.equal(secureApiUrl('http://10.0.0.5:8081'), false)
  assert.equal(secureApiUrl('https://user:pass@example.com'), false)
  assert.equal(secureApiUrl('ftp://example.com'), false)
  assert.equal(secureApiUrl('not a url'), false)
  const config = makeConfig('notify-telegram-api-url', { channels: [{ id: 'tg', type: 'telegram', chatId: '-100123' }] })
  const calls = []
  const notifier = createNotifier(config, {
    env: { SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN, SHAPEWALL_TELEGRAM_API_URL: 'http://proxy.example.com' },
    fetch: async (url) => {
      calls.push(url)
      return new Response('{"ok":true}', { status: 200 })
    },
  })
  const result = await notifier.deliver(config.notifications.channels[0], testEvent(config))
  notifier.stop()
  assert.deepEqual(calls, [], 'the token never goes to a plain-http host')
  assert.deepEqual([result.skipped, result.error], [true, 'SHAPEWALL_TELEGRAM_API_URL must be an https URL (http only for localhost)'])
})

test('telegram: a board link Telegram cannot open (localhost, a private address) is plain text, not an <a href>', () => {
  for (const [url, linked] of [
    ['https://wall.example.com/', true],
    ['http://203.0.113.9:4600/', true],
    ['http://localhost:4600/', false],
    ['http://127.0.0.1:4600/', false],
    ['http://[::1]:4600/', false],
    ['http://192.168.1.20:4600/', false],
    ['http://10.1.2.3/', false],
    ['http://172.20.0.2/', false],
    ['http://100.101.1.2/', false],
    ['http://myhost:4600/', false],
    ['http://board.local/', false],
  ])
    assert.equal(publicLink(url), linked, url)
  const config = makeConfig('notify-telegram-local-link', { channels: [{ type: 'telegram', chatId: '-100123' }] })
  const comment = { id: 7, pageId: 'home', viewport: 'desktop', author: 'Robin', body: 'hi', replies: [] }
  const event = { id: 'e1', type: 'comment.created', at: '2026-01-01T00:00:00.000Z', boardId: 'sample', commentId: 7, comment }
  const local = telegramMessage(config, config.notifications.channels[0], event, 'http://localhost:4600/')
  assert.ok(!local.text.includes('<a href'), local.text)
  assert.match(local.text, /\nOpen on the board: http:\/\/localhost:4600\/\?board=sample&amp;c=7/)
  const hosted = telegramMessage(config, config.notifications.channels[0], event, 'https://wall.example.com/')
  assert.match(hosted.text, /<a href="https:\/\/wall\.example\.com\/\?board=sample/)
})

test('telegram: HTML escaping, pings only for mapped people, link back, 4096 limit', () => {
  const config = makeConfig('notify-telegram-messages', {
    people: { sam: { telegram: '123456789' } },
    channels: [{ type: 'telegram', chatId: '-100123' }],
  })
  const channel = config.notifications.channels[0]
  const comment = {
    id: 7,
    pageId: 'pricing',
    viewport: 'phone',
    author: 'Robin <b>',
    body: '<a href="x">hi</a> @everyone @sam & @lee: price "wrong"',
    replies: [],
  }
  const event = { id: 'e1', type: 'comment.created', at: '2026-01-01T00:00:00.000Z', boardId: 'sample', commentId: 7, comment }
  const message = telegramMessage(config, channel, event, 'https://wall.example.com/')
  assert.equal(message.chat_id, '-100123')
  assert.equal(message.parse_mode, 'HTML')
  assert.deepEqual(message.link_preview_options, { is_disabled: true })
  const { text } = message
  assert.match(text, /^<b>Robin &lt;b&gt; commented on Pricing \(phone\)<\/b>\n<blockquote>/)
  assert.ok(text.includes('&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt;'), 'comment HTML is escaped')
  assert.ok(!text.includes('<a href="x">'))
  assert.ok(text.includes('@\u200beveryone') && text.includes('@\u200blee'), 'unmapped names cannot ping')
  assert.ok(text.includes('<a href="tg://user?id=123456789">@sam</a>'), 'mapped person pinged')
  assert.ok(text.includes(' &amp; '))
  assert.ok(text.endsWith('\n<a href="https://wall.example.com/?board=sample&amp;c=7&amp;filter=all&amp;vp=phone">Open on the board</a>'))

  const mention = telegramMessage(config, channel, { ...event, type: 'comment.mentioned', handle: 'sam' }, 'https://wall.example.com/')
  assert.match(mention.text, /^<a href="tg:\/\/user\?id=123456789">@sam<\/a> <b>@\u200bsam, you were mentioned on #7/)

  // A page title far past the limit: clipped, so the visible text fits.
  const long = structuredClone(config)
  long.boards[0].pages.push({ id: 'huge', title: 'T'.repeat(10000) })
  const big = telegramMessage(
    long,
    channel,
    { ...event, comment: { ...comment, pageId: 'huge', body: 'x'.repeat(5000) } },
    'https://w.example.com/',
  )
  const visible = big.text.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot|#39);/g, '_')
  assert.ok(visible.length <= TELEGRAM_TEXT_MAX, `visible text is ${visible.length}`)
  assert.ok(visible.includes('...'))
})

test('telegram: sendMessage through a mocked fetch, 429 retry_after, errors without the token', async () => {
  const calls = []
  const answers = [
    { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } } },
    { status: 200, json: { ok: true, result: { message_id: 1 } } },
    {
      status: 400,
      json: { ok: false, error_code: 400, description: `Bad Request: chat not found for bot${TG_TOKEN}\nreally` },
    },
    {
      status: 400,
      json: {
        ok: false,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -1009 },
      },
    },
  ]
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const answer = answers.shift() || { status: 200, json: { ok: true } }
    return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }
  const env = { SHAPEWALL_TELEGRAM_BOT_TOKEN: TG_TOKEN }
  const config = makeConfig('notify-telegram-deliver', {
    boardUrl: 'https://wall.example.com/',
    people: { sam: { telegram: '123456789' } },
    channels: [{ id: 'tg', type: 'telegram', chatId: '-100123' }],
  })
  const [channel] = config.notifications.channels
  const logs = []
  const notifier = createNotifier(config, { env, fetch, log: (line) => logs.push(line), backoffMs: 1 }).start()
  try {
    const board = config.boards[0]
    await createComment(config, board, { ...anchorless, body: 'Please check, @sam' })
    assert.equal(await notifier.flush(5000), true)
    // One created message (mentions ping inside it), retried once after the 429.
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[1].body.chat_id, '-100123')
    assert.ok(calls[1].body.text.includes('<a href="tg://user?id=123456789">@sam</a>'))
    assert.ok(
      logs.some((line) => /^notify: tg sent comment\.created #1$/.test(line)),
      logs.join('\n'),
    )

    const failed = await notifier.deliver(channel, testEvent(config), { retries: 0 })
    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'HTTP 400 (Bad Request: chat not found for bot[token] really)')
    const moved = await notifier.deliver(channel, testEvent(config), { retries: 0 })
    assert.match(moved.error, /^HTTP 400 \(Bad Request: group chat was upgraded to a supergroup chat; the chat id is now -1009\)$/)

    // A malformed token is never put in a URL.
    const before = calls.length
    const odd = createNotifier(config, { env: { SHAPEWALL_TELEGRAM_BOT_TOKEN: 'abc/../x' }, fetch })
    const skipped = await odd.deliver(channel, testEvent(config))
    odd.stop()
    assert.equal(calls.length, before)
    assert.deepEqual(
      [skipped.skipped, skipped.error],
      [true, 'SHAPEWALL_TELEGRAM_BOT_TOKEN does not look like a bot token from @BotFather'],
    )

    // Network errors quote the URL (and so the token): the log never does.
    const broken = createNotifier(config, {
      env,
      fetch: async (url) => {
        throw new TypeError(`fetch failed for ${url}`, { cause: { code: 'ECONNRESET' } })
      },
      log: (line) => logs.push(line),
      backoffMs: 1,
    })
    const down = await broken.deliver(channel, testEvent(config), { retries: 1 })
    broken.stop()
    assert.deepEqual([down.ok, down.attempts, down.error], [false, 2, 'network error (ECONNRESET)'])
    for (const line of [...logs, failed.error, moved.error, down.error]) assert.ok(!line.includes(TG_TOKEN), `leaks the token: ${line}`)
    assert.equal(telegramDetail({ description: `x ${TG_TOKEN} y` }, null), 'x [token] y')
  } finally {
    notifier.stop()
  }
})
