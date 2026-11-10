import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bech32 } from '@scure/base'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadBridgeConfig, publicBridge, SIGNERS } from '../src/buzz/config.js'
import { createGateway, startGateway } from '../src/buzz/gateway.js'
import { createBuzzClient } from '../src/buzz/client.js'
import { buzzOwner } from '../src/buzz/routes.js'
import { envelope, ownerAttested, verifiedFeed } from '../src/buzz/verify.js'
import { parseSignerEnv, checkSigner, performSignerOperation, memberPubkeys } from '../src/buzz/signer-child.js'
import { openJournal } from '../src/buzz/store.js'
import { requireCleanBuzzEnvironment, withoutBuzzCredentials, signerBaseEnvironment } from '../src/buzz/environment.js'
import { fixture, signed, pubkeys, keys, signerEnv, attestation, channel, ownerRequest } from './fixtures/buzz.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { exportStatic } from '../src/export.js'
import { SAMPLE } from './helpers.js'

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}
async function post(server, route, data) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return { status: response.status, ...(await response.json()) }
}

test('feed accepts complete valid signatures only, exact channel and configured authors, deduplicated', () => {
  const f = fixture()
  try {
    const event = signed('<script>not executable</script>')
    const bad = [
      { ...event, content: 'forged' },
      { ...event, sig: '0'.repeat(128) },
      { ...event, sig: undefined },
      signed('other channel', { tags: [['h', 'other']] }),
      signed('two channels', {
        tags: [
          ['h', channel],
          ['h', channel],
        ],
      }),
      signed('stranger', { author: 'stranger' }),
      signed('future', { created_at: Math.floor(Date.now() / 1000) + 600 }),
      { ...event, tags: [null] },
    ]
    assert.deepEqual(verifiedFeed([event, event, ...bad], f.config), [event])
  } finally {
    f.close()
  }
})

test('owner attestation verifies exact signer/owner binding and canonical time/kind conditions', () => {
  assert.equal(ownerAttested(attestation('codex'), pubkeys.codex, pubkeys.owner), true)
  for (const conditions of ['kind=8', 'kind=09', 'created_at<1', 'created_at>4294967296', 'kind=9&', 'x=1'])
    assert.equal(ownerAttested(attestation('codex', { conditions }), pubkeys.codex, pubkeys.owner), false, conditions)
  assert.equal(ownerAttested(attestation('codex'), pubkeys.claude, pubkeys.owner), false)
  assert.equal(ownerAttested(attestation('codex', { owner: 'stranger' }), pubkeys.codex, pubkeys.owner), false)
  assert.equal(
    ownerAttested(attestation('codex', { conditions: 'kind=9&created_at>1&created_at<4294967295' }), pubkeys.codex, pubkeys.owner),
    true,
  )
})

test('EnvironmentFile parser interprets only three permitted variables, never shell commands or unrelated credentials', () => {
  const env = signerEnv('claude')
  const parsed = parseSignerEnv(
    `MODEL_KEY=do-not-include\nBUZZ_PRIVATE_KEY=${env.BUZZ_PRIVATE_KEY}\nBUZZ_AUTH_TAG='${env.BUZZ_AUTH_TAG}'\nBUZZ_RELAY_URL="${env.BUZZ_RELAY_URL}"\nUNRELATED=$(touch SHOULD_NOT_EXIST)\n`,
  )
  assert.deepEqual(parsed, env)
  assert.throws(() => parseSignerEnv(`BUZZ_PRIVATE_KEY=a\nBUZZ_PRIVATE_KEY=b`))
  assert.throws(() => parseSignerEnv(`BUZZ_PRIVATE_KEY=$(touch file)\nBUZZ_AUTH_TAG='[]'\nBUZZ_RELAY_URL=wss://relay.invalid`))
  const sentinel = {
    BUZZ_PRIVATE_KEY: 'test-secret',
    BUZZ_AUTH_TAG: 'test-attestation',
    BUZZ_RELAY_URL: 'test-relay',
    MODEL_KEY: 'keep-provider-config',
  }
  assert.deepEqual(withoutBuzzCredentials(sentinel), { MODEL_KEY: 'keep-provider-config' })
  assert.throws(() => requireCleanBuzzEnvironment(sentinel))
  requireCleanBuzzEnvironment({})
  assert.deepEqual(Object.keys(signerBaseEnvironment()).sort(), ['HOME', 'LANG', 'PATH'])
})

test('signer preflight checks derived public identity, owner proof and fixed relay before executing CLI', async () => {
  const f = fixture()
  try {
    const signer = f.config.agents.find((a) => a.id === 'claude')
    checkSigner(signerEnv('claude'), signer, f.config)
    checkSigner({ ...signerEnv('claude'), BUZZ_PRIVATE_KEY: bech32.encode('nsec', bech32.toWords(keys.claude)) }, signer, f.config)
    let calls = 0
    const execute = async () => {
      calls++
      return []
    }
    const request = { ...ownerRequest(f), action: 'dispatch' }
    for (const env of [
      signerEnv('codex'),
      { ...signerEnv('claude'), BUZZ_AUTH_TAG: attestation('claude', { owner: 'stranger' }) },
      { ...signerEnv('claude'), BUZZ_RELAY_URL: 'wss://elsewhere.invalid' },
    ])
      await assert.rejects(performSignerOperation(f.config, request, env, execute))
    assert.equal(calls, 0)
  } finally {
    f.close()
  }
})

test('pre-publish payload preserves exact JSON text and cannot add mentions; selected target only', async () => {
  const f = fixture()
  try {
    const text = 'mail me@example.invalid; @Codex @goose; nostr:npub1fake; NOSTR:npub1other; code `$(touch nope)` and \\u0040 keep literal.'
    const request = { ...ownerRequest(f, { text }), action: 'dispatch' }
    let publications = 0
    const result = await performSignerOperation(f.config, request, signerEnv('claude'), async (args, env, content) => {
      assert.deepEqual(Object.keys(env).sort(), ['BUZZ_AUTH_TAG', 'BUZZ_PRIVATE_KEY', 'BUZZ_RELAY_URL'])
      if (args[0] === 'channels')
        return [
          { pubkey: pubkeys.claude, role: 'owner' },
          { pubkey: pubkeys.owner, role: 'member' },
          { pubkey: pubkeys.codex, role: 'bot' },
        ]
      publications++
      assert.deepEqual(args, ['messages', 'send', '--channel', channel, '--kind', '9', '--mention', pubkeys.codex, '--content', '-'])
      assert.equal(content.includes('@'), false)
      assert.equal(/nostr:/i.test(content), false)
      assert.equal(JSON.parse(content).request, text)
      assert.equal(JSON.parse(content).transportSigner.pubkey, pubkeys.claude)
      return { accepted: true, event_id: 'a'.repeat(64), mention_pubkeys: [pubkeys.codex] }
    })
    assert.equal(publications, 1)
    assert.equal(result.outcome, 'accepted')
    let send = false
    await assert.rejects(
      performSignerOperation(f.config, { ...request, target: 'goose' }, signerEnv('codex'), async (args) => {
        if (args[0] === 'channels')
          return [
            { pubkey: pubkeys.claude, role: 'owner' },
            { pubkey: pubkeys.owner, role: 'member' },
            { pubkey: pubkeys.codex, role: 'bot' },
          ]
        send = true
      }),
    )
    assert.equal(send, false, 'missing goose membership is rejected before publishing')
  } finally {
    f.close()
  }
})

test('recorded CLI membership object shape is required; malformed/duplicate records fail before publish', async () => {
  const f = fixture()
  try {
    const recorded = [
      { pubkey: pubkeys.claude, role: 'owner' },
      { pubkey: pubkeys.owner, role: 'member' },
      { pubkey: pubkeys.codex, role: 'bot' },
    ]
    assert.deepEqual(
      [...memberPubkeys(recorded)],
      recorded.map((m) => m.pubkey),
    )
    const malformed = [
      null,
      {},
      [],
      [pubkeys.claude],
      [null],
      [recorded[0], recorded[0]],
      [{ pubkey: 'invalid', role: 'bot' }],
      [{ pubkey: [pubkeys.claude], role: 'bot' }],
      [{ pubkey: pubkeys.claude }],
      [{ pubkey: pubkeys.claude, role: 1 }],
      [{ ...recorded[0], unexpected: true }],
    ]
    for (const members of malformed) {
      let published = false
      await assert.rejects(
        performSignerOperation(f.config, { ...ownerRequest(f), action: 'dispatch' }, signerEnv('claude'), async (args) => {
          if (args[0] === 'channels') return members
          published = true
        }),
      )
      assert.equal(published, false)
    }
  } finally {
    f.close()
  }
})

test('every malformed acknowledgment after one publish attempt remains unknown, never not_sent', async () => {
  const f = fixture()
  try {
    const replies = [
      null,
      undefined,
      false,
      'not an acknowledgment',
      0,
      [],
      {},
      { accepted: true, event_id: { toString: null }, mention_pubkeys: [pubkeys.codex] },
      { accepted: true, event_id: 'a'.repeat(64), mention_pubkeys: [pubkeys.codex, pubkeys.goose] },
      { accepted: true, event_id: 'a'.repeat(64), mention_pubkeys: null },
    ]
    for (const reply of replies) {
      let sends = 0
      const result = await performSignerOperation(
        f.config,
        { ...ownerRequest(f), action: 'dispatch' },
        signerEnv('claude'),
        async (args) => {
          if (args[0] === 'channels')
            return [
              { pubkey: pubkeys.claude, role: 'owner' },
              { pubkey: pubkeys.owner, role: 'member' },
              { pubkey: pubkeys.codex, role: 'bot' },
            ]
          sends++
          return reply
        },
      )
      assert.equal(sends, 1)
      assert.deepEqual(result, { outcome: 'unknown' })
    }
  } finally {
    f.close()
  }
})

test('durable receipts deduplicate exact requests and never resend unknown delivery or infer completion from agent replies', async () => {
  const f = fixture()
  let gateway, server
  try {
    const events = []
    let sends = 0
    const run = async (_file, request) => {
      if (request.action === 'feed') return { events }
      if (request.action === 'event') return { events: events.filter((e) => e.id === request.eventId) }
      sends++
      assert.equal(fs.statSync(path.join(f.config.stateDir, 'receipts.json')).mode & 0o777, 0o600)
      const persisted = JSON.parse(fs.readFileSync(path.join(f.config.stateDir, 'receipts.json')))
      assert.equal(persisted.at(-1).status, 'publishing', 'intent is durable before side effect')
      return { outcome: 'unknown' }
    }
    gateway = createGateway(f.config, { run })
    server = await listen(gateway.app)
    const request = ownerRequest(f)
    const first = await post(server, 'dispatch', request)
    assert.equal(first.receipt.status, 'unknown')
    assert.equal((await post(server, 'dispatch', request)).receipt.status, 'unknown')
    assert.equal(sends, 1)
    assert.equal((await post(server, 'dispatch', { ...request, text: 'different' })).status, 409)
    events.push(signed('Done, fixed it.'))
    let feed = await post(server, 'feed', { root: f.root, board: 'home' })
    assert.equal(feed.receipts[0].status, 'unknown', 'reply cannot complete or correlate request')
    assert.equal(feed.events[0].verified, true)
    assert.equal(feed.events[0].sig, undefined)
    assert.equal(feed.events[0].tags, undefined)
    const emitted = signed(first.receipt.envelope, {
      author: 'claude',
      tags: [
        ['h', channel],
        ['p', pubkeys.codex],
      ],
    })
    events.push(emitted)
    feed = await post(server, 'feed', { root: f.root, board: 'home' })
    assert.equal(feed.receipts[0].status, 'sent')
    assert.equal(feed.receipts[0].eventId, emitted.id)
    assert.equal((await post(server, 'dispatch', request)).receipt.status, 'sent')
    assert.equal(sends, 1)
  } finally {
    if (server) await new Promise((r) => server.close(r))
    gateway?.close()
    f.close()
  }
})

test('sent receipt requires independently verified exact outgoing event, not CLI acknowledgment alone', async () => {
  const f = fixture()
  let gateway, server
  try {
    let emitted
    let extra = false
    const run = async (_file, request) => {
      if (request.action === 'event') return { events: [emitted] }
      const target = f.config.agents.find((a) => a.id === request.target)
      const signer = f.config.agents.find((a) => a.id === SIGNERS[target.id])
      emitted = signed(envelope({ ...request, target, signer, project: f.config.projects[0] }), {
        author: signer.id,
        tags: [['h', channel], ['p', target.pubkey], ...(extra ? [['p', pubkeys.goose]] : [])],
      })
      return { outcome: 'accepted', eventId: emitted.id }
    }
    gateway = createGateway(f.config, { run })
    server = await listen(gateway.app)
    assert.equal((await post(server, 'dispatch', ownerRequest(f))).receipt.status, 'sent')
    extra = true
    assert.equal((await post(server, 'dispatch', ownerRequest(f))).receipt.status, 'unknown')
  } finally {
    if (server) await new Promise((r) => server.close(r))
    gateway?.close()
    f.close()
  }
})

test('concurrent dispatch/feed is refused while one publish is active, with no queued or repeated publish', async () => {
  const f = fixture()
  let gateway, server, release
  try {
    let sends = 0
    const waiting = new Promise((resolve) => {
      release = resolve
    })
    gateway = createGateway(f.config, {
      run: async () => {
        sends++
        await waiting
        return { outcome: 'unknown' }
      },
    })
    server = await listen(gateway.app)
    const request = ownerRequest(f)
    const first = post(server, 'dispatch', request)
    while (!gateway.busy()) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal((await post(server, 'dispatch', request)).status, 409)
    assert.equal((await post(server, 'feed', { root: f.root, board: 'home' })).status, 409)
    assert.equal(sends, 1)
    release()
    assert.equal((await first).receipt.status, 'unknown')
    assert.equal((await post(server, 'dispatch', request)).receipt.status, 'unknown')
    assert.equal(sends, 1)
  } finally {
    release?.()
    if (server) await new Promise((r) => server.close(r))
    gateway?.close()
    f.close()
  }
})

test('journal lock excludes concurrent gateways and interrupted publishing becomes unknown without publishing', () => {
  const f = fixture()
  try {
    const journal = openJournal(f.config.stateDir)
    journal.add({ requestId: 'interrupted', root: f.root, board: 'home', status: 'publishing' })
    assert.throws(() => openJournal(f.config.stateDir), /already owns/)
    journal.close()
    const reopened = openJournal(f.config.stateDir)
    assert.equal(reopened.get('interrupted').status, 'unknown')
    reopened.close()
  } finally {
    f.close()
  }
})

test('private map/path validation excludes public files, symlinks and source/capture data', () => {
  const f = fixture()
  try {
    loadBridgeConfig(f.file)
    assert.throws(() => publicBridge(f.config, f.root, 'unmapped'))
    fs.chmodSync(f.file, 0o644)
    assert.throws(() => loadBridgeConfig(f.file), /private/)
    fs.chmodSync(f.file, 0o600)
    const link = path.join(f.privateDir, 'linked.json')
    fs.symlinkSync(f.file, link)
    assert.throws(() => loadBridgeConfig(link), /symlinks/)
    assert.throws(() => createBuzzClient(f.file, { dir: f.root, outputDir: f.privateDir }), /capture\/export/)
    const nested = path.join(f.root, 'private')
    fs.mkdirSync(nested, { mode: 0o700 })
    fs.copyFileSync(f.file, path.join(nested, 'bridge.json'))
    assert.throws(() => loadBridgeConfig(path.join(nested, 'bridge.json')), /outside source/)
  } finally {
    f.close()
  }
})

test('owner access excludes ordinary local visits, paired viewers, shared boards and read-only boards', () => {
  const token = 'synthetic-owner-token'
  const req = { headers: { host: '127.0.0.1:4600', 'x-shapewall-settings-token': token }, socket: { remoteAddress: '127.0.0.1' } }
  const options = { settingsToken: token, shared: false, readOnly: false }
  assert.equal(buzzOwner(req, options), true)
  assert.equal(buzzOwner({ ...req, headers: { host: req.headers.host } }, options), false)
  assert.equal(buzzOwner({ headers: {}, shapewallAccess: { kind: 'device' } }, options), false)
  assert.equal(buzzOwner({ headers: {}, shapewallAccess: { kind: 'identity' } }, options), true)
  assert.equal(buzzOwner(req, { ...options, shared: true }), false)
  assert.equal(buzzOwner(req, { ...options, readOnly: true }), false)
  assert.equal(buzzOwner({ ...req, headers: { ...req.headers, 'x-forwarded-for': '127.0.0.1' } }, options), false)
})

test('foreground gateway uses private Unix socket and fixed mapped source context', async () => {
  const f = fixture()
  let gateway
  try {
    gateway = await startGateway(f.file, { run: async () => ({ events: [] }) })
    assert.equal(fs.statSync(f.config.socketPath).mode & 0o777, 0o600)
    const client = createBuzzClient(f.file, { dir: f.root, outputDir: path.join(f.root, '.shapewall') })
    const view = await client.request('view', 'home')
    assert.equal(view.channel.id, channel)
    assert.equal(view.sourceRoot, f.root)
    assert.equal(view.agents.find((a) => a.id === 'codex').signer.pubkey, pubkeys.claude)
    assert.throws(() => client.request('view', 'unmapped'))
    await assert.rejects(startGateway(f.file), /already owns/)
  } finally {
    await gateway?.stop()
    f.close()
  }
})

test('real board API requires owner capability, exact origin/JSON and fixed request fields; export omits all bridge state', async () => {
  const f = fixture()
  let gateway, app, server
  try {
    const config = normalizeConfig(
      { ...structuredClone(SAMPLE), id: 'home' },
      { dir: f.root, file: path.join(f.root, 'shapewall.config.json') },
    )
    gateway = await startGateway(f.file, { run: async () => ({ events: [signed('Private fixture feed')] }) })
    const token = 'fixture-owner-capability'
    app = createApp({ config, buzzBridge: f.file, settingsToken: token, chat: false, env: { HOME: f.dir, XDG_CONFIG_HOME: f.dir } })
    server = await listen(app)
    const origin = `http://127.0.0.1:${server.address().port}`
    const headers = { 'Content-Type': 'application/json', 'X-Shapewall-Settings-Token': token, Origin: origin }
    const route = `${origin}/api/buzz/boards/home/view`
    assert.equal(
      (await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status,
      404,
    )
    assert.equal(
      (await fetch(route, { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.invalid' }, body: '{}' })).status,
      404,
    )
    assert.equal(
      (await fetch(route, { method: 'POST', headers: { ...headers, Origin: origin.replace('http:', 'https:') }, body: '{}' })).status,
      403,
    )
    assert.equal((await fetch(route, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
    for (const key of ['channel', 'pubkey', 'signer', 'path', 'root', 'command', 'relayUrl'])
      assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ [key]: 'untrusted' }) })).status, 400, key)
    assert.equal((await fetch(route, { method: 'POST', headers, body: '{}' })).status, 200)
    const anonymousInfo = await (await fetch(`${origin}/api/info`)).json()
    assert.equal(anonymousInfo.buzzAvailable, false)
    assert.equal(JSON.stringify(anonymousInfo).includes(channel), false)
    const ownerInfo = await (await fetch(`${origin}/api/info`, { headers })).json()
    assert.equal(ownerInfo.buzzAvailable, true)
    assert.equal(JSON.stringify(ownerInfo).includes(channel), false, 'info exposes availability, not the private map')
    const clientDir = path.join(f.dir, 'fake-client')
    fs.mkdirSync(clientDir)
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<html><head></head><body></body></html>')
    const out = path.join(f.dir, 'export')
    await exportStatic(config, { out, clientDir })
    const scan = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? scan(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    for (const file of scan(out)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const privateValue of [channel, pubkeys.codex, f.file, f.config.socketPath, 'Private fixture feed', 'BUZZ_AUTH_TAG'])
        assert.equal(text.includes(privateValue), false, path.basename(file))
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data/info.json'))).buzzAvailable, undefined)
  } finally {
    if (server) await new Promise((r) => server.close(r))
    if (app) stopChildren(app)
    await gateway?.stop()
    f.close()
  }
})

test('CLI clean re-exec removes inherited Buzz names before gateway startup without changing model configuration', async () => {
  const f = fixture()
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../bin/shapewall.js', import.meta.url)), 'buzz-bridge', '--bridge-config', f.file],
    {
      env: {
        ...process.env,
        BUZZ_PRIVATE_KEY: 'fictional-sentinel-key',
        BUZZ_AUTH_TAG: 'fictional-sentinel-attestation',
        BUZZ_RELAY_URL: 'wss://fictional-sentinel.invalid',
        MODEL_KEY: 'fictional-provider-sentinel',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Clean gateway fixture startup timed out.')), 10000)
      child.stdout.on('data', (part) => {
        output += part
        if (output.includes('Private Buzz gateway ready')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Clean gateway fixture exited before startup.'))
      })
    })
    const descendants = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/)
    assert.equal(descendants.length, 1)
    const names = fs
      .readFileSync(`/proc/${descendants[0]}/environ`, 'utf8')
      .split('\0')
      .map((entry) => entry.split('=', 1)[0])
    for (const name of ['BUZZ_PRIVATE_KEY', 'BUZZ_AUTH_TAG', 'BUZZ_RELAY_URL']) assert.equal(names.includes(name), false, name)
    assert.equal(names.includes('MODEL_KEY'), true, 'ordinary model configuration is preserved in server, never inherited by signer child')
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    f.close()
  }
})

test('the bridge is off without signer files: no personal default path', () => {
  const f = fixture()
  try {
    const files = f.config.signerFiles
    assert.deepEqual(loadBridgeConfig(f.file, {}).signerFiles, files)
    const raw = JSON.parse(fs.readFileSync(f.file, 'utf8'))
    delete raw.signerFiles
    fs.writeFileSync(f.file, JSON.stringify(raw), { mode: 0o600 })
    assert.throws(() => loadBridgeConfig(f.file, {}), /Buzz bridge is off: no signer file for codex/)
    assert.throws(() => loadBridgeConfig(f.file, { SHAPEWALL_BUZZ_SIGNER_CODEX: files.codex }), /no signer file for claude/)
    const env = { SHAPEWALL_BUZZ_SIGNER_CODEX: files.codex, SHAPEWALL_BUZZ_SIGNER_CLAUDE: files.claude }
    assert.deepEqual(loadBridgeConfig(f.file, env).signerFiles, files)
    assert.throws(() => loadBridgeConfig(f.file, { ...env, SHAPEWALL_BUZZ_SIGNER_CLAUDE: 'relative.env' }), /absolute/)
    assert.throws(
      () => loadBridgeConfig(f.file, { ...env, SHAPEWALL_BUZZ_SIGNER_CLAUDE: path.join(f.root, 'claude.env') }),
      /outside source/,
    )
  } finally {
    f.close()
  }
})
