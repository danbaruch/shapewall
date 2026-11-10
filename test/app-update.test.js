import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createApp, stopChildren } from '../src/server/app.js'
import { runningVersion } from '../src/update/routes.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const servers = []
after(() => {
  for (const { app, server } of servers) {
    stopChildren(app)
    server.close()
  }
})

function helper(source) {
  const dir = tempDir('app-update-helper')
  const file = path.join(dir, 'update')
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  return file
}
// An update capability long enough for the startup check (32+ characters).
const PROXY_TOKEN = 'proxy-capability-0123456789abcdef'
const answer = JSON.stringify({ latest: { version: '0.2.0', revision: 'abcdef1234567' }, updateAvailable: true })
async function fixture(options = {}) {
  const app = createApp({
    config: sampleConfig('app-update'),
    clientDir: tempDir('app-update-client'),
    chat: false,
    env: {},
    settingsToken: 'owner-capability',
    ...options,
  })
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  servers.push({ app, server })
  const port = server.address().port
  const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': 'owner-capability' }
  const status = (extra = {}) => request(port, 'GET', '/api/app-update', { headers: extra })
  const post = (action, overrides = {}) =>
    request(port, 'POST', `/api/app-update/${action}`, { body: {}, ...overrides, headers: { ...headers, ...overrides.headers } })
  return { app, port, headers, status, post }
}
async function completed(instance) {
  for (let i = 0; i < 200; i++) {
    const response = await instance.status(instance.headers)
    if (response.json.job?.state !== 'running') return response.json
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Update helper did not finish')
}

test('version is bounded artifact metadata; unsupported installs never run a default updater', async () => {
  assert.match(runningVersion({ SHAPEWALL_BUILD_REVISION: 'ABCDEF123' }).revision, /^abcdef123$/)
  assert.equal(runningVersion({ SHAPEWALL_BUILD_REVISION: 'secret/url?token=value' }).revision, runningVersion({}).revision)
  const instance = await fixture()
  const status = await instance.status()
  assert.equal(status.status, 200)
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.equal(status.json.current.version, '0.2.0')
  assert.equal(status.json.supported, false)
  assert.equal(status.json.canUpdate, false)
  assert.match(status.json.reason, /person who installed/)
  assert.equal(status.json.job, null)
  assert.equal((await instance.post('check')).status, 503)
  assert.equal((await instance.post('apply')).status, 503)
  assert.equal((await (await fixture({ appUpdate: { helper: 'npm update' } })).status()).json.supported, false)
})

test('owner capability, origin, Host, JSON and empty body are required for mutations', async () => {
  const file = helper(`console.log(${JSON.stringify(answer)})`)
  const instance = await fixture({ appUpdate: { helper: file } })
  assert.equal((await instance.status()).json.canUpdate, false)
  assert.equal((await instance.status(instance.headers)).json.canUpdate, true)
  for (const token of ['', 'wrong'])
    assert.equal((await instance.post('check', { headers: { 'X-Shapewall-Settings-Token': token } })).status, 403)
  assert.equal((await instance.post('check', { headers: { Origin: '' } })).status, 403)
  assert.equal((await instance.post('check', { headers: { Origin: 'https://attacker.example' } })).status, 403)
  assert.equal((await instance.post('check', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await instance.post('check', { headers: { 'X-Forwarded-For': '127.0.0.1' } })).status, 403)
  assert.equal((await instance.post('check', { headers: { Host: 'attacker.example' } })).status, 421)
  assert.equal((await instance.post('check', { body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415)
  for (const body of [{ command: 'id' }, { revision: 'main' }, { args: ['evil'] }, [], null])
    assert.equal((await instance.post('check', { body })).status, 400)
  assert.equal((await instance.status()).json.job, null)
})

test('shared proxy accepts only fixed update token, never local settings capability', async () => {
  const file = helper(`console.log(${JSON.stringify(answer)})`)
  const instance = await fixture({
    shared: true,
    env: { SHAPEWALL_UPDATE_HELPER: file, SHAPEWALL_UPDATE_TOKEN: PROXY_TOKEN },
  })
  assert.equal((await instance.post('check')).status, 403)
  assert.equal((await instance.post('check', { headers: { 'X-Shapewall-Update-Token': 'wrong' } })).status, 403)
  assert.equal((await instance.post('check', { headers: { 'X-Shapewall-Update-Token': PROXY_TOKEN, Origin: '' } })).status, 403)
  assert.equal((await instance.post('check', { headers: { 'X-Shapewall-Update-Token': PROXY_TOKEN } })).status, 202)
  const status = await completed(instance)
  assert.equal(status.job.state, 'succeeded')
  assert.ok(!JSON.stringify(status).includes(PROXY_TOKEN))
  assert.ok(!JSON.stringify(status).includes(file))
})

test('a short update token is refused at startup', () => {
  assert.throws(
    () =>
      createApp({
        config: sampleConfig('app-update-short'),
        clientDir: tempDir('app-update-short-client'),
        chat: false,
        env: { SHAPEWALL_UPDATE_TOKEN: 'short' },
      }),
    /SHAPEWALL_UPDATE_TOKEN must be at least 32 characters/,
  )
})

test('wrong update tokens are rate limited; the right one still passes once over the limit', async () => {
  const file = helper(`console.log(${JSON.stringify(answer)})`)
  const instance = await fixture({ shared: true, env: { SHAPEWALL_UPDATE_HELPER: file, SHAPEWALL_UPDATE_TOKEN: PROXY_TOKEN } })
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await instance.post('check', { headers: { 'X-Shapewall-Update-Token': `wrong-${index}` } })).status, 403)
    assert.equal((await instance.status({ 'X-Shapewall-Update-Token': `wrong-get-${index}` })).json.canUpdate, false)
  }
  const limited = await instance.post('check', { headers: { 'X-Shapewall-Update-Token': 'wrong-again' } })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.error.code, 'update_rate_limited')
  assert.ok(Number(limited.headers['retry-after']) > 0)
  assert.equal((await instance.status({ 'X-Shapewall-Update-Token': 'wrong-again' })).status, 429)
  // Behind the update proxy every caller shares one address: wrong guesses
  // from others must not lock out the token's holder.
  const holder = await instance.status({ 'X-Shapewall-Update-Token': PROXY_TOKEN })
  assert.equal(holder.status, 200)
  assert.equal(holder.json.canUpdate, true)
  assert.equal((await instance.post('check', { headers: { 'X-Shapewall-Update-Token': PROXY_TOKEN } })).status, 202)
  // Requests without the header are not affected.
  assert.equal((await instance.status()).status, 200)
})

test('check and apply serialize; fixed helper sees only the hard-coded operation', async () => {
  const trace = path.join(tempDir('app-update-trace'), 'calls')
  const file = helper(`
    import fs from 'node:fs'
    fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args: process.argv.slice(2), revision: process.env.SHAPEWALL_RUNNING_REVISION}) + '\\n')
    setTimeout(() => console.log(${JSON.stringify(answer)}), 100)
  `)
  const instance = await fixture({
    appUpdate: { helper: file },
    env: { SHAPEWALL_BUILD_REVISION: '123456789abcd', SHAPEWALL_RUNNING_REVISION: 'untrusted-parent-value' },
  })
  assert.equal((await instance.post('apply')).json.error.code, 'update_not_available')
  assert.equal((await instance.post('check')).status, 202)
  assert.equal((await instance.post('check')).json.error.code, 'update_busy')
  assert.equal((await instance.post('apply')).json.error.code, 'update_busy')
  let status = await completed(instance)
  assert.equal(status.checkedAt, status.job.finishedAt)
  assert.equal(status.updateAvailable, true)
  assert.equal(status.latest.revision, 'abcdef1234567')
  assert.equal((await instance.post('apply')).status, 202)
  assert.equal((await instance.post('apply')).json.error.code, 'update_busy')
  status = await completed(instance)
  assert.equal(status.job.state, 'succeeded')
  assert.equal(status.job.action, 'apply')
  assert.equal(status.current.revision, '123456789abcd', 'running artifact only changes after restart')
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse), [
    { args: ['check'], revision: '123456789abcd' },
    { args: ['apply'], revision: '123456789abcd' },
  ])
})

test('helper errors, invalid protocol, output floods and timeouts are bounded and redacted', async () => {
  for (const [source, options, expected] of [
    ['console.error("secret-provider-error"); process.exit(2)', {}, /helper failed/],
    ['console.log("secret-invalid-json")', {}, /invalid response/],
    ['console.log(JSON.stringify({latest:{version:"https://secret.example"},updateAvailable:true}))', {}, /invalid response/],
    ['process.stdout.write("secret".repeat(20000))', {}, /too much output/],
    ['setTimeout(() => {}, 10000)', { checkTimeoutMs: 20 }, /timed out/],
  ]) {
    const instance = await fixture({ appUpdate: { helper: helper(source), ...options } })
    assert.equal((await instance.post('check')).status, 202)
    const status = await completed(instance)
    assert.equal(status.job.state, 'failed')
    assert.match(status.job.error, expected)
    assert.ok(!JSON.stringify(status).includes('secret'))
    assert.equal(status.checkedAt, null)
    assert.equal(status.updateAvailable, false)
  }
})

test('a failed newer check invalidates an earlier positive check', async () => {
  const marker = path.join(tempDir('app-update-marker'), 'called')
  const file = helper(`
    import fs from 'node:fs'
    if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1)
    fs.writeFileSync(${JSON.stringify(marker)}, '1')
    console.log(${JSON.stringify(answer)})
  `)
  const instance = await fixture({ appUpdate: { helper: file } })
  await instance.post('check')
  assert.equal((await completed(instance)).updateAvailable, true)
  await instance.post('check')
  assert.equal((await completed(instance)).job.state, 'failed')
  assert.equal((await instance.post('apply')).json.error.code, 'update_not_available')
})

test('read-only boards reveal version but cannot check or apply updates', async () => {
  const instance = await fixture({ readOnly: true, appUpdate: { helper: helper(`console.log(${JSON.stringify(answer)})`) } })
  assert.equal((await instance.status(instance.headers)).json.canUpdate, false)
  assert.equal((await instance.post('check')).status, 403)
  assert.equal((await instance.post('apply')).status, 403)
  assert.equal((await instance.status()).json.job, null)
})

test('only successful apply may request the explicitly installed delayed restart callback', async () => {
  const protocol = JSON.stringify({ latest: { version: '0.2.0', revision: 'abcdef1234567' }, updateAvailable: true, restartRequired: true })
  let restarts = 0
  const instance = await fixture({
    appUpdate: { helper: helper(`console.log(${JSON.stringify(protocol)})`), restartDelayMs: 30, onRestart: () => restarts++ },
  })
  assert.equal((await instance.post('apply')).status, 409)
  assert.equal((await instance.post('apply', { headers: { 'X-Shapewall-Settings-Token': 'wrong' } })).status, 403)
  await instance.post('check')
  assert.equal((await completed(instance)).job.state, 'succeeded')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(restarts, 0, 'a check cannot restart even when its helper asks')
  await instance.post('apply')
  assert.equal((await completed(instance)).job.state, 'succeeded')
  assert.equal((await instance.post('apply')).json.error.code, 'update_busy')
  assert.equal((await instance.post('check')).json.error.code, 'update_busy')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(restarts, 1)
  assert.equal((await instance.post('apply')).json.error.code, 'update_busy', 'restart stays pending until process exits')

  for (const source of [
    `console.log(${JSON.stringify(protocol)}); if (process.argv[2] === 'apply') process.exit(1)`,
    `console.log(${JSON.stringify(answer)})`,
  ]) {
    const failure = await fixture({ appUpdate: { helper: helper(source), restartDelayMs: 0, onRestart: () => restarts++ } })
    await failure.post('check')
    await completed(failure)
    await failure.post('apply')
    await completed(failure)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(restarts, 1, 'failure or absent explicit restart request cannot restart')
  }
})
