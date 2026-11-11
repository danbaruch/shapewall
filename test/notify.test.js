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
import { createNotifier, signPayload } from '../src/notify/index.js'
import { commentLink, discordMessage, slackMessage } from '../src/notify/messages.js'
import { addReply, createComment, setAgentStatus, updateComment } from '../src/store.js'
import { main } from '../src/cli.js'
import { runDoctor } from '../src/doctor.js'
import { createApp } from '../src/server/app.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const SECRET = 'whsec-test-0123456789'

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
      ['comment.status_changed', 'comment.resolved', 'comment.status_changed', 'comment.reopened', 'comment.status_changed'],
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

test('config: channels, defaults, people and env-only channels; secrets only by name', () => {
  const config = makeConfig('notify-config', {
    boardUrl: 'https://shapewall.example.com/',
    retries: 2,
    people: { '@Sam': { email: 'sam@example.com', slack: 'U012AB3CD', discord: '123456789012' } },
    channels: [
      { id: 'hooks', type: 'webhook', url: 'https://hooks.example.com/shapewall', events: ['created', 'comment.resolved'] },
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
  assert.match(all, /channels\[0\]\.url: a slack webhook URL is a secret/)
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
      { id: 'dead', type: 'webhook', urlEnv: 'DEAD_HOOK', secretEnv: 'DEAD_SECRET', events: ['created'] },
      { id: 'unready', type: 'slack', events: ['created'] },
      { id: 'other-board', type: 'webhook', urlEnv: 'DEAD_HOOK', secretEnv: 'DEAD_SECRET', events: ['created'], boards: ['sample'] },
    ],
  })
  config.notifications.channels[2].boards = ['elsewhere']
  const logs = []
  const env = { DEAD_HOOK: `${dead.base}/hook/secret-path`, DEAD_SECRET: SECRET }
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
          { id: 'hooks', type: 'webhook', urlEnv: 'TEST_NOTIFY_HOOK', secretEnv: 'TEST_NOTIFY_SECRET', events: ['resolved'] },
          { id: 'team', type: 'slack', urlEnv: 'TEST_NOTIFY_SLACK' },
        ],
      },
    }),
  )
  const saved = { ...process.env }
  process.env.TEST_NOTIFY_HOOK = `${hook.base}/hook`
  process.env.TEST_NOTIFY_SECRET = SECRET
  delete process.env.TEST_NOTIFY_SLACK
  const run = async (argv) => {
    const lines = []
    const errors = []
    const code = await main(argv, { out: (line) => lines.push(line), err: (line) => errors.push(line) })
    return { code, text: lines.join('\n'), errors: errors.join('\n') }
  }
  try {
    const list = await run(['notify', 'list', '--config', file])
    assert.match(list.text, /^hooks {2}webhook\n {2}events: resolved\n {2}ready$/m)
    assert.match(list.text, /^team {2}slack\n {2}events: created, replied, resolved, reopened\n {2}not ready: set TEST_NOTIFY_SLACK$/m)
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
    assert.match(unready.text, /set TEST_NOTIFY_SLACK/)
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
    assert.match(check.fix, /Set TEST_NOTIFY_SLACK for team/)
    assert.ok(!JSON.stringify(doctor).includes(SECRET))
  } finally {
    for (const key of ['TEST_NOTIFY_HOOK', 'TEST_NOTIFY_SECRET', 'TEST_NOTIFY_SLACK']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await hook.close()
  }
})
