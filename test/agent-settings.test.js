// Settings > Agent: the user-local settings file, its precedence between the
// environment and shapewall.config.json, and /api/agent/settings (who may
// read and save it, confirmations, live reload, Test connection). Against
// the OpenAI stub and the ACP stub only: never a real endpoint, key or agent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createApp, stopChildren } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { agentSettings } from '../src/agent/config.js'
import {
  SETTINGS_FILE_VAR,
  projectKey,
  saveUserAgentEntry,
  userAgentEntry,
  userSettingsFile,
  validateUserEntry,
} from '../src/agent/user-settings.js'
import { PROXY_HEADERS, confirmHash, localRequest, pendingConfirmations, settingsTokenOk } from '../src/agent/settings-routes.js'
import { remoteAgentProblem } from '../src/cli.js'
import { fileURLToPath } from 'node:url'
import { SAMPLE, request, tempDir } from './helpers.js'
import { startOpenAIStub } from './fixtures/openai-stub.js'

const KEY = 'sk-settings-0123456789abcdefSECRET'
const TOKEN = 'settings-token-for-tests-0123456789'

// Saves through the confirm step, as the board does: post, and when the
// server asks, post again with the hash of what it asked.
async function confirmSave(entry, settings) {
  const first = await entry.post('/api/agent/settings', { settings })
  if (!first.json?.confirm) return first
  return entry.post('/api/agent/settings', { settings, confirm: first.json.confirmHash })
}
const STUB_ACP = fileURLToPath(new URL('./fixtures/acp-stub.mjs', import.meta.url))
let stub

before(async () => {
  stub = await startOpenAIStub()
})
const homes = []
after(() => {
  stub?.close()
  for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true })
})

// A private folder for a settings file (a shared /tmp would be refused).
function settingsHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-settings-'))
  homes.push(dir)
  return { dir, file: path.join(dir, 'shapewall', 'agents.json') }
}

function project(name, agent) {
  const dir = tempDir(name)
  return normalizeConfig(
    { ...structuredClone(SAMPLE), ...(agent ? { agent } : {}) },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
}

const envFor = (home, extra = {}) => ({ PATH: process.env.PATH, XDG_CONFIG_HOME: home.dir, ...extra })

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

// A board with the settings token. get/post send it (and post an Origin of
// the board) unless told otherwise: { token: null, origin: null }.
async function board(config, env, options = {}) {
  const app = createApp({ config, clientDir: tempDir('settings-client'), env, settingsToken: TOKEN, ...options })
  const server = await listen(app)
  const port = server.address().port
  const auth = ({ token = TOKEN, origin = `http://127.0.0.1:${port}` } = {}, extra = {}) => ({
    ...(token ? { 'X-Shapewall-Settings-Token': token } : {}),
    ...(origin ? { Origin: origin } : {}),
    ...extra,
  })
  return {
    app,
    port,
    get: (pathname, headers, how = {}) => request(port, 'GET', pathname, { headers: auth({ ...how, origin: null }, headers) }),
    post: (pathname, body, headers, how = {}) => request(port, 'POST', pathname, { body, headers: auth(how, headers) }),
    close: () => {
      stopChildren(app)
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---- The file ---------------------------------------------------------------------

test('file: XDG_CONFIG_HOME, then HOME/.config; SHAPEWALL_AGENT_SETTINGS_FILE wins; none without a home', () => {
  assert.equal(userSettingsFile({ XDG_CONFIG_HOME: '/x/conf', HOME: '/home/a' }), path.join('/x/conf', 'shapewall', 'agents.json'))
  assert.equal(userSettingsFile({ HOME: '/home/a' }), path.join('/home/a', '.config', 'shapewall', 'agents.json'))
  assert.equal(userSettingsFile({ [SETTINGS_FILE_VAR]: '/y/agents.json', XDG_CONFIG_HOME: '/x' }), path.resolve('/y/agents.json'))
  // A relative XDG_CONFIG_HOME is ignored (the spec says so); no home, no file.
  assert.equal(userSettingsFile({ XDG_CONFIG_HOME: 'rel', HOME: '/home/a' }), path.join('/home/a', '.config', 'shapewall', 'agents.json'))
  assert.equal(userSettingsFile({}), null)
  assert.equal(agentSettings(project('settings-nohome'), {}).settingsFile, null)
})

test('file: saved per project real path, private, other projects kept, never a key', () => {
  const home = settingsHome()
  const env = envFor(home)
  const one = project('settings-one')
  const two = project('settings-two')
  saveUserAgentEntry(one.dir, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKeyEnv: 'OPENAI_API_KEY' }, env)
  saveUserAgentEntry(two.dir, { model: 'other' }, env)
  const data = JSON.parse(fs.readFileSync(home.file, 'utf8'))
  assert.deepEqual(Object.keys(data.projects).sort(), [projectKey(one.dir), projectKey(two.dir)].sort())
  assert.equal(data.projects[projectKey(one.dir)].model, 'gpt-x')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(home.file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(home.file)).mode & 0o777, 0o700)
  }
  // A symlink to the project is the same project.
  const link = path.join(tempDir('settings-link'), 'project')
  fs.symlinkSync(one.dir, link)
  assert.equal(userAgentEntry(link, env).entry.model, 'gpt-x')
  // An empty entry removes the project; the other stays.
  saveUserAgentEntry(two.dir, {}, env)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(home.file, 'utf8')).projects), [projectKey(one.dir)])
})

test('validate: no keys, only model key variables, real hosts, a command without a shell', () => {
  assert.match(validateUserEntry({ apiKey: KEY }).problems.join(), /keys are never saved/)
  assert.match(validateUserEntry({ token: 'x' }).problems.join(), /keys are never saved/)
  assert.match(validateUserEntry({ apiKeyEnv: 'GITHUB_TOKEN' }).problems.join(), /not a model key variable/)
  assert.match(validateUserEntry({ apiKeyEnv: 'RESEND_API_KEY' }).problems.join(), /not a model key variable/)
  assert.match(validateUserEntry({ apiKeyEnv: 'lower' }).problems.join(), /apiKeyEnv/)
  assert.match(validateUserEntry({ backend: 'shell' }).problems.join(), /backend/)
  assert.match(validateUserEntry({ baseUrl: 'file:///etc/passwd' }).problems.join(), /baseUrl/)
  assert.match(validateUserEntry({ keyHosts: [{ host: 'bad host/x', apiKeyEnv: 'X_API_KEY' }] }).problems.join(), /not a host name/)
  assert.match(validateUserEntry({ keyHosts: ['ok.example.com'] }).problems.join(), /not a host name/)
  assert.match(validateUserEntry({ keyHosts: [{ host: 'ok.example.com', apiKeyEnv: 'GITHUB_TOKEN' }] }).problems.join(), /not a model key/)
  assert.match(validateUserEntry({ acpCommand: 'agent | sh' }).problems.join(), /without a shell/)
  assert.match(validateUserEntry({ acpCommand: 'a\nb' }).problems.join(), /one line/)
  assert.match(validateUserEntry({ somethingElse: 1 }).problems.join(), /not an agent setting/)
  // Empty fields are "not set"; URLs lose a trailing slash; hosts are lower case.
  assert.deepEqual(
    validateUserEntry({
      baseUrl: 'https://LLM.example.com/v1/',
      model: '',
      keyHosts: [{ host: 'LLM.example.com', apiKeyEnv: 'X_API_KEY' }],
      label: null,
    }).entry,
    {
      baseUrl: 'https://LLM.example.com/v1',
      keyHosts: [{ host: 'llm.example.com', apiKeyEnv: 'X_API_KEY' }],
    },
  )
})

test('file: one other users may write, or that is not JSON, is not used and says so', { skip: process.platform === 'win32' }, () => {
  const home = settingsHome()
  const env = envFor(home)
  const config = project('settings-unsafe', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' })
  saveUserAgentEntry(config.dir, { model: 'from-settings' }, env)
  fs.chmodSync(home.file, 0o666)
  let settings = agentSettings(config, env)
  assert.equal(settings.configured, false)
  assert.match(settings.problem, /writable by other users/)
  fs.chmodSync(home.file, 0o600)
  assert.equal(agentSettings(config, env).model, 'from-settings')
  fs.writeFileSync(home.file, '{ not json')
  settings = agentSettings(config, env)
  assert.equal(settings.configured, false)
  assert.match(settings.problem, /is not valid/)
  assert.throws(() => saveUserAgentEntry(config.dir, { model: 'x' }, env), /is not valid/)
})

// ---- Precedence ---------------------------------------------------------------------

test('precedence: environment > settings > config, with sources', () => {
  const home = settingsHome()
  const config = project('settings-precedence', { baseUrl: 'https://api.openai.com/v1', model: 'from-config', label: 'Config' })
  let env = envFor(home)
  assert.equal(agentSettings(config, env).model, 'from-config')
  assert.equal(agentSettings(config, env).sources.model, 'config')
  saveUserAgentEntry(config.dir, { model: 'from-settings', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' }, env)
  let settings = agentSettings(config, env)
  assert.equal(settings.model, 'from-settings')
  assert.equal(settings.host, 'api.deepseek.com')
  assert.equal(settings.keyVar, 'DEEPSEEK_API_KEY')
  assert.equal(settings.label, 'Config')
  assert.deepEqual(settings.sources, {
    backend: 'config',
    baseUrl: 'settings',
    model: 'settings',
    apiKeyEnv: 'settings',
    label: 'config',
    vision: 'config',
  })
  env = envFor(home, { SHAPEWALL_AGENT_MODEL: 'from-env', SHAPEWALL_AGENT_BASE_URL: `http://127.0.0.1:${stub.port}/v1` })
  settings = agentSettings(config, env)
  assert.equal(settings.model, 'from-env')
  assert.equal(settings.host, `127.0.0.1:${stub.port}`)
  assert.equal(settings.sources.model, 'env')
  assert.equal(settings.sources.baseUrl, 'env')
})

test('precedence: an ACP command from the flag or env beats the saved one; the saved one counts only with backend acp', () => {
  const home = settingsHome()
  const env = envFor(home)
  const config = project('settings-acp', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' })
  saveUserAgentEntry(config.dir, { acpCommand: `${STUB_ACP} saved` }, env)
  // A command alone does not switch the backend.
  assert.equal(agentSettings(config, env).backend, 'openai-compatible')
  saveUserAgentEntry(config.dir, { backend: 'acp', acpCommand: `${STUB_ACP} saved` }, env)
  let settings = agentSettings(config, env)
  assert.equal(settings.backend, 'acp')
  assert.equal(settings.configured, true)
  assert.deepEqual(settings.acp.argv, [STUB_ACP, 'saved'])
  assert.deepEqual(settings.sources, { backend: 'settings', acpCommand: 'settings' })
  settings = agentSettings(config, { ...env, SHAPEWALL_AGENT_ACP: `${STUB_ACP} env` })
  assert.deepEqual(settings.acp.argv, [STUB_ACP, 'env'])
  assert.equal(settings.sources.acpCommand, 'env')
  settings = agentSettings(config, { ...env, SHAPEWALL_AGENT_ACP: `${STUB_ACP} env` }, { acp: `${STUB_ACP} flag` })
  assert.deepEqual(settings.acp.argv, [STUB_ACP, 'flag'])
  assert.equal(settings.sources.acpCommand, 'flag')
  // Saved backend wins over a config that asks for ACP.
  const acpRepo = project('settings-acp-repo', { backend: 'acp' })
  saveUserAgentEntry(acpRepo.dir, { backend: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'm' }, env)
  assert.equal(agentSettings(acpRepo, env).backend, 'openai-compatible')
  // A shared --chat board refuses at start when the saved agent is ACP.
  assert.match(
    remoteAgentProblem({ flags: { chat: true }, host: '0.0.0.0', chat: true, readOnly: false, config, acp: null, env }),
    /Refusing to start/,
  )
})

test('key hosts: a host only the config names needs confirming; Settings > Agent can confirm it', () => {
  const home = settingsHome()
  const env = envFor(home, { SHAPEWALL_AGENT_API_KEY: KEY })
  const config = project('settings-hosts', { baseUrl: 'https://llm.example.net/v1', model: 'm' })
  assert.match(agentSettings(config, env).problem, /llm\.example\.net, which only the config names/)
  assert.deepEqual(pendingConfirmations({}, { saved: {}, repo: config.agent, env }).confirm, [
    { kind: 'host', host: 'llm.example.net', keyVar: 'SHAPEWALL_AGENT_API_KEY' },
  ])
  // Allowed for another key variable only: still not confirmed for this one.
  saveUserAgentEntry(config.dir, { keyHosts: [{ host: 'llm.example.net', apiKeyEnv: 'OTHER_API_KEY' }] }, env)
  assert.equal(agentSettings(config, env).configured, false)
  saveUserAgentEntry(config.dir, { keyHosts: [{ host: 'llm.example.net', apiKeyEnv: 'SHAPEWALL_AGENT_API_KEY' }] }, env)
  assert.equal(agentSettings(config, env).configured, true)
  // Changing the key variable asks again for the same host.
  const saved = { keyHosts: [{ host: 'llm.example.net', apiKeyEnv: 'SHAPEWALL_AGENT_API_KEY' }] }
  assert.deepEqual(pendingConfirmations({ ...saved }, { saved, repo: config.agent, env }).confirm, [])
  assert.deepEqual(pendingConfirmations({ ...saved, apiKeyEnv: 'OTHER_API_KEY' }, { saved, repo: config.agent, env }).confirm, [
    { kind: 'host', host: 'llm.example.net', keyVar: 'OTHER_API_KEY' },
  ])
  // Known hosts, this machine and the environment's URL need nothing.
  assert.deepEqual(pendingConfirmations({ baseUrl: 'https://api.openai.com/v1' }, { saved: {}, repo: {}, env }).confirm, [])
  assert.deepEqual(pendingConfirmations({ baseUrl: 'http://localhost:11434/v1' }, { saved: {}, repo: {}, env }).confirm, [])
  assert.deepEqual(
    pendingConfirmations(
      { baseUrl: 'https://other.example' },
      { saved: {}, repo: {}, env: { ...env, SHAPEWALL_AGENT_BASE_URL: 'https://x.example' } },
    ).confirm,
    [],
  )
  // A new command needs confirming; the one already saved does not.
  assert.deepEqual(pendingConfirmations({ acpCommand: 'a b' }, { saved: {}, repo: {}, env }).confirm, [{ kind: 'command', command: 'a b' }])
  assert.deepEqual(pendingConfirmations({ acpCommand: 'a b' }, { saved: { acpCommand: 'a b' }, repo: {}, env }).confirm, [])
})

// ---- Who may use the screen ----------------------------------------------------------

test('local request: loopback peer and Host, no proxy headers, same Origin', () => {
  const req = (headers, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers: { host: 'localhost:4600', ...headers } })
  assert.equal(localRequest(req({})), true)
  assert.equal(localRequest(req({}, '::ffff:127.0.0.1')), true)
  assert.equal(localRequest(req({ origin: 'http://localhost:4600' })), true)
  assert.equal(localRequest(req({}, '192.168.1.5')), false)
  assert.equal(localRequest(req({ 'x-forwarded-for': '203.0.113.9' })), false)
  assert.equal(localRequest(req({ forwarded: 'for=203.0.113.9' })), false)
  assert.equal(localRequest(req({ host: 'board.example.com' })), false)
  assert.equal(localRequest(req({ origin: 'https://evil.example' })), false)
  assert.equal(localRequest(req({ origin: 'null' })), false)
})

test('api: refused for a shared board, through a proxy, from another origin; absent on a read-only board', async () => {
  const home = settingsHome()
  const config = project('settings-refusals', { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model' })
  const env = envFor(home)
  const shared = await board(config, env, { allowedHosts: null })
  try {
    const info = await shared.get('/api/info')
    assert.equal(info.json.agent.settingsEditable, false)
    assert.equal((await shared.get('/api/agent/settings')).json.error.code, 'settings_shared')
    const save = await shared.post('/api/agent/settings', { settings: { model: 'x' } })
    assert.equal(save.status, 403)
    assert.equal((await shared.post('/api/agent/settings/test', {})).status, 403)
  } finally {
    await shared.close()
  }
  const local = await board(config, env)
  try {
    assert.equal((await local.get('/api/info')).json.agent.settingsEditable, true)
    // Without the token: hidden, with the hint that a link would open it.
    const locked = (await local.get('/api/info', {}, { token: null })).json.agent
    assert.equal(locked.settingsEditable, false)
    assert.equal(locked.settingsLocked, true)
    const proxied = await local.get('/api/agent/settings', { 'X-Forwarded-For': '203.0.113.9' })
    assert.equal(proxied.status, 403)
    assert.equal(proxied.json.error.code, 'settings_remote')
    assert.equal((await local.get('/api/info', { 'X-Forwarded-For': '203.0.113.9' })).json.agent.settingsEditable, false)
    const crossSite = await local.post('/api/agent/settings', { settings: { model: 'x' } }, { Origin: 'https://evil.example' })
    assert.equal(crossSite.status, 403)
    // Nothing was written by the refused requests.
    assert.equal(fs.existsSync(home.file), false)
  } finally {
    await local.close()
  }
  const readOnly = await board(config, env, { readOnly: true })
  try {
    assert.equal((await readOnly.get('/api/info')).json.agent, null)
    assert.equal((await readOnly.get('/api/agent/settings')).status, 404)
  } finally {
    await readOnly.close()
  }
})

test('api: a shared board does not run an ACP agent saved on another board of the project', async () => {
  const home = settingsHome()
  const env = envFor(home)
  const config = project('settings-shared-acp', { baseUrl: 'https://api.openai.com/v1', model: 'm' })
  const shared = await board(config, env, { allowedHosts: null })
  try {
    assert.equal((await shared.get('/api/agent/status')).json.configured, true)
    saveUserAgentEntry(config.dir, { backend: 'acp', acpCommand: STUB_ACP }, env)
    const status = (await shared.get('/api/agent/status')).json
    assert.equal(status.backend, 'acp')
    assert.equal(status.configured, false)
    assert.match(status.problem, /--allow-remote-agent/)
  } finally {
    await shared.close()
  }
  const allowed = await board(config, env, { allowedHosts: null, allowRemoteAgent: true })
  try {
    assert.equal((await allowed.get('/api/agent/status')).json.configured, true)
  } finally {
    await allowed.close()
  }
})

// ---- Saving and testing ----------------------------------------------------------------

test('api: save switches the chat over at once; new hosts and commands need confirm; keys never land on disk', async () => {
  const home = settingsHome()
  const env = envFor(home, { SHAPEWALL_AGENT_API_KEY: KEY, OTHER_API_KEY: 'sk-other-0123456789abcdef' })
  const config = project('settings-save', { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model' })
  const entry = await board(config, env)
  try {
    let view = (await entry.get('/api/agent/settings')).json
    assert.equal(view.editable, true)
    assert.deepEqual(view.project, { root: fs.realpathSync(config.dir), configFile: config.file })
    assert.equal(view.effective.model, 'stub-model')
    assert.equal(view.effective.sources.model, 'config')
    assert.equal(view.effective.hasKey, true)
    assert.deepEqual(view.keyVarsSet, ['OTHER_API_KEY', 'SHAPEWALL_AGENT_API_KEY'])
    assert.equal(JSON.stringify(view).includes(KEY), false)

    // A model change needs no confirmation and is live for the next message.
    let saved = await entry.post('/api/agent/settings', { settings: { model: 'stub-other', label: 'Other' } })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.confirm, undefined)
    assert.equal(saved.json.effective.model, 'stub-other')
    assert.equal(saved.json.effective.sources.model, 'settings')
    assert.equal((await entry.get('/api/agent/status')).json.model, 'stub-other')
    stub.calls.length = 0
    const message = await fetch(`http://127.0.0.1:${entry.port}/api/agent/boards/sample/threads/board/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hi' }),
    })
    await message.text()
    assert.equal(stub.calls.find((call) => call.url === '/v1/chat/completions').body.model, 'stub-other')

    // A key in the body is refused, not saved.
    const withKey = await entry.post('/api/agent/settings', { settings: { model: 'm', apiKey: KEY } })
    assert.equal(withKey.status, 400)
    assert.equal(withKey.text.includes(KEY), false)

    // A host the key has not gone to before: 409 with what to confirm, then saved.
    const asked = await entry.post('/api/agent/settings', { settings: { baseUrl: 'https://llm.example.org/v1', model: 'm' } })
    assert.equal(asked.status, 200)
    assert.equal(asked.json.effective, undefined)
    assert.deepEqual(asked.json.confirm, [{ kind: 'host', host: 'llm.example.org', keyVar: 'SHAPEWALL_AGENT_API_KEY' }])
    assert.match(asked.json.confirmHash, /^[0-9a-f]{32}$/)
    assert.equal((await entry.get('/api/agent/status')).json.model, 'stub-other')
    // confirm: true, or the hash of other items, asks again and saves nothing.
    for (const confirm of [
      true,
      'x'.repeat(32),
      confirmHash([{ kind: 'host', host: 'other.example', keyVar: 'SHAPEWALL_AGENT_API_KEY' }]),
    ]) {
      const again = await entry.post('/api/agent/settings', { settings: { baseUrl: 'https://llm.example.org/v1', model: 'm' }, confirm })
      assert.deepEqual(again.json.confirm, asked.json.confirm)
    }
    assert.equal((await entry.get('/api/agent/status')).json.model, 'stub-other')
    saved = await entry.post('/api/agent/settings', {
      settings: { baseUrl: 'https://llm.example.org/v1', model: 'm' },
      confirm: asked.json.confirmHash,
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json.saved.keyHosts, [{ host: 'llm.example.org', apiKeyEnv: 'SHAPEWALL_AGENT_API_KEY' }])
    assert.equal(saved.json.effective.host, 'llm.example.org')
    assert.equal(saved.json.effective.configured, true)

    // An ACP command: 409 first, then the chat is an ACP agent with no restart.
    const command = { backend: 'acp', acpCommand: STUB_ACP }
    assert.equal((await entry.post('/api/agent/settings', { settings: command })).json.confirm[0].kind, 'command')
    saved = await confirmSave(entry, command)
    assert.equal(saved.status, 200)
    const status = (await entry.get('/api/agent/status')).json
    assert.equal(status.backend, 'acp')
    assert.equal(status.local, true)
    assert.equal(status.configured, true)
    // The same command again needs no confirmation.
    assert.equal((await entry.post('/api/agent/settings', { settings: { ...command, label: 'Stub' } })).status, 200)

    const disk = fs.readFileSync(home.file, 'utf8')
    assert.equal(disk.includes(KEY), false)
    assert.equal(disk.includes('sk-other'), false)
    // Nothing went into the project: no shapewall.config.json was written.
    assert.equal(fs.existsSync(config.file), false)
  } finally {
    await entry.close()
  }
})

test('test connection: models list, one-token fallback, a refused key (redacted), unreachable, ACP handshake', async () => {
  const home = settingsHome()
  const env = envFor(home, { SHAPEWALL_AGENT_API_KEY: KEY })
  const config = project('settings-test', { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model' })
  const entry = await board(config, env)
  const save = (settings) => confirmSave(entry, settings)
  const run = async () => (await entry.post('/api/agent/settings/test', {})).json
  try {
    let result = await run()
    assert.equal(result.ok, true)
    assert.match(result.message, /lists stub-model/)
    assert.equal(result.sendsKey, true)
    assert.equal(result.host, `127.0.0.1:${stub.port}`)
    assert.equal(stub.calls.at(-1).headers.authorization, `Bearer ${KEY}`)

    await save({ model: 'not-listed' })
    result = await run()
    assert.equal(result.ok, true)
    assert.match(result.details.join(), /not in the 2 models listed/)
    assert.equal(stub.calls.at(-1).body.max_tokens, 5)

    await save({ baseUrl: `http://127.0.0.1:${stub.port}/bad`, model: 'm' })
    result = await run()
    assert.equal(result.ok, false)
    assert.match(result.message, /refused the API key \(401\)/)
    assert.equal(JSON.stringify(result).includes(KEY), false)

    const closed = await listen(createApp({ config }))
    const deadPort = closed.address().port
    await new Promise((resolve) => closed.close(resolve))
    await save({ baseUrl: `http://127.0.0.1:${deadPort}/v1`, model: 'm' })
    result = await run()
    assert.equal(result.ok, false)
    assert.match(result.message, /Could not reach/)

    await save({ backend: 'acp', acpCommand: STUB_ACP })
    result = await run()
    assert.equal(result.ok, true, result.message)
    // The handshake does not prove a login: it says so, with the fix.
    assert.match(result.message, /^Handshake ok, login not checked: ACP stub 1\.0\.0 started and answered\.$/)
    assert.doesNotMatch(result.message, /Connected/)
    assert.equal(result.vision, true)
    assert.ok(result.details.some((line) => /not logged in: run the agent once in a terminal/.test(line)))
    assert.equal(result.sendsKey, false)

    await save({ backend: 'acp', acpCommand: 'no-such-agent-cli-xyz' })
    result = await run()
    assert.equal(result.ok, false)
    assert.match(result.message, /not an executable on PATH/)
  } finally {
    await entry.close()
  }
})

// ---- Security review of PR #20 ----------------------------------------------------------

// A TCP forwarder on this machine (socat, ssh -R, tailscale serve --tcp,
// ngrok tcp) or a proxy that rewrites Host makes a remote request look like
// loopback with a loopback Host and no proxy headers.
function forwarder(port) {
  const server = net.createServer((socket) => {
    const upstream = net.connect(port, '127.0.0.1')
    socket.pipe(upstream).pipe(socket)
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('review 1: a forwarded request without the settings token gets 404, cannot save or run a command', async () => {
  const home = settingsHome()
  const env = envFor(home, { SHAPEWALL_AGENT_API_KEY: KEY })
  const config = project('settings-review1', { baseUrl: `http://127.0.0.1:/v1`, model: 'stub-model' })
  const entry = await board(config, env)
  const relay = await forwarder(entry.port)
  const through = relay.address().port
  try {
    // The attacker's curl, through the forwarder: no Origin, no token.
    const via = (method, pathname, body, headers = {}) =>
      request(through, method, pathname, { body, headers: { Host: `127.0.0.1:${entry.port}`, ...headers } })
    assert.equal((await via('GET', '/api/agent/settings')).status, 404)
    const save = await via('POST', '/api/agent/settings', { settings: { backend: 'acp', acpCommand: STUB_ACP }, confirm: true })
    assert.equal(save.status, 404)
    assert.equal((await via('POST', '/api/agent/settings/test', {})).status, 404)
    // A guessed token, and one with the right length, are 404 too.
    for (const token of ['guess', 'x'.repeat(TOKEN.length)]) {
      assert.equal((await via('GET', '/api/agent/settings', undefined, { 'X-Shapewall-Settings-Token': token })).status, 404)
    }
    assert.equal((await via('GET', '/api/info')).json.agent.settingsEditable, false)
    assert.equal(fs.existsSync(home.file), false)
    // The board's own page, with the token from the terminal link, works.
    assert.equal((await entry.get('/api/agent/settings')).status, 200)
  } finally {
    relay.close()
    await entry.close()
  }
  // A server started without a token has no settings at all.
  const off = await board(config, env, { settingsToken: null })
  try {
    assert.equal((await off.get('/api/agent/settings')).status, 404)
    const info = (await off.get('/api/info')).json.agent
    assert.equal(info.settingsEditable, false)
    assert.equal(info.settingsLocked, false)
  } finally {
    await off.close()
  }
  assert.equal(settingsTokenOk({ headers: { 'x-shapewall-settings-token': TOKEN } }, TOKEN), true)
  assert.equal(settingsTokenOk({ headers: { 'x-shapewall-settings-token': TOKEN } }, null), false)
  assert.equal(settingsTokenOk({ headers: {} }, TOKEN), false)
})

test('review 2: writes need this board as Origin and Sec-Fetch-Site same-origin; every proxy header refuses', async () => {
  const home = settingsHome()
  const env = envFor(home)
  const config = project('settings-review2', { baseUrl: 'https://api.openai.com/v1', model: 'm' })
  const entry = await board(config, env)
  try {
    const body = { settings: { model: 'x' } }
    assert.equal((await entry.post('/api/agent/settings', body, {}, { origin: null })).json.error.code, 'settings_origin')
    assert.equal((await entry.post('/api/agent/settings/test', {}, {}, { origin: null })).status, 403)
    assert.equal((await entry.post('/api/agent/settings', body, {}, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await entry.post('/api/agent/settings', body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await entry.post('/api/agent/settings', body, { 'Sec-Fetch-Site': 'same-site' })).status, 403)
    assert.equal(fs.existsSync(home.file), false)
    assert.equal((await entry.post('/api/agent/settings', body, { 'Sec-Fetch-Site': 'same-origin' })).status, 200)
    for (const name of PROXY_HEADERS) {
      const refused = await entry.get('/api/agent/settings', { [name]: name === 'via' ? '1.1 proxy' : '203.0.113.9' })
      assert.equal(refused.status, 403, name)
      assert.equal(refused.json.error.code, 'settings_remote', name)
    }
    for (const name of ['via', 'x-forwarded-proto', 'cf-connecting-ip', 'tailscale-user-login']) assert.ok(PROXY_HEADERS.includes(name))
  } finally {
    await entry.close()
  }
})

test('review 5: a file replaced with the same size and mtime is read again; parallel saves lose nothing', async () => {
  const home = settingsHome()
  const env = envFor(home)
  const one = project('settings-review5')
  saveUserAgentEntry(one.dir, { model: 'aaaa' }, env)
  assert.equal(userAgentEntry(one.dir, env).entry.model, 'aaaa')
  const { mtime } = fs.statSync(home.file)
  const swapped = fs.readFileSync(home.file, 'utf8').replace('"aaaa"', '"bbbb"')
  const temp = `${home.file}.swap`
  fs.writeFileSync(temp, swapped, { mode: 0o600 })
  fs.utimesSync(temp, mtime, mtime)
  fs.renameSync(temp, home.file)
  assert.equal(userAgentEntry(one.dir, env).entry.model, 'bbbb')

  // Two processes saving 25 projects each at once: all 50 are there.
  const file = path.join(home.dir, 'parallel', 'agents.json')
  fs.mkdirSync(path.dirname(file), { mode: 0o700 })
  const dir = tempDir('settings-parallel')
  const script = fileURLToPath(new URL('./fixtures/save-settings.mjs', import.meta.url))
  const run = (prefix) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, file, dir, prefix, '25'], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errors = ''
      child.stderr.on('data', (chunk) => (errors += chunk))
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(errors))))
    })
  await Promise.all([run('a'), run('b')])
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects).length, 50)
  assert.equal(fs.existsSync(`${file}.lock`), false)

  // A lock left behind by a crashed save is taken over once stale.
  fs.writeFileSync(`${file}.lock`, '99999')
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(`${file}.lock`, old, old)
  saveUserAgentEntry(path.join(dir, 'a-0'), { model: 'after-crash' }, { SHAPEWALL_AGENT_SETTINGS_FILE: file })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[projectKey(path.join(dir, 'a-0'))].model, 'after-crash')
})

// Starts `shapewall serve` and reads its first lines until `until` matches.
function startServe(args, env) {
  const cli = fileURLToPath(new URL('../bin/shapewall.js', import.meta.url))
  const child = spawn(process.execPath, [cli, 'serve', '--port', '0', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${output}`)), 15000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (/Shapewall is serving/.test(output)) {
        // The settings line follows the first one in the same write or the next.
        setTimeout(() => {
          clearTimeout(timer)
          resolve(output)
        }, 300)
      }
    })
    child.on('exit', () => reject(new Error(`serve exited: ${output}`)))
  })
  return { child, ready }
}

test('review 1: shapewall serve prints a link with a fresh settings token; the token works, a shared board has none', async () => {
  const home = settingsHome()
  const dir = tempDir('settings-serve')
  fs.writeFileSync(
    path.join(dir, 'shapewall.config.json'),
    JSON.stringify({ ...SAMPLE, agent: { baseUrl: 'https://api.openai.com/v1', model: 'm' } }),
  )
  // Not a terminal here: the link is printed only on request.
  const env = { PATH: process.env.PATH, XDG_CONFIG_HOME: home.dir, HOME: home.dir, SHAPEWALL_PRINT_OWNER_LINK: '1' }
  const config = ['--config', path.join(dir, 'shapewall.config.json')]
  const local = startServe(config, env)
  let firstToken = null
  try {
    const output = await local.ready
    const link =
      /Private owner link \(settings, sharing; keep it to yourself\): (http:\/\/127\.0\.0\.1:(\d+)\/#settings-token=([A-Za-z0-9_-]{32}))/.exec(
        output,
      )
    assert.ok(link, output)
    const port = Number(link[2])
    firstToken = link[3]
    assert.equal((await request(port, 'GET', '/api/agent/settings')).status, 404)
    const ok = await request(port, 'GET', '/api/agent/settings', { headers: { 'X-Shapewall-Settings-Token': link[3] } })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.editable, true)
  } finally {
    local.child.kill('SIGTERM')
  }
  // A second start makes another token.
  const again = startServe(config, env)
  const shared = startServe([...config, '--allowed-host', 'board.example.com', '--chat'], env)
  try {
    const [second, sharedOutput] = await Promise.all([again.ready, shared.ready])
    const secondToken = /#settings-token=([A-Za-z0-9_-]+)/.exec(second)?.[1]
    assert.ok(secondToken)
    assert.notEqual(secondToken, firstToken)
    assert.doesNotMatch(sharedOutput, /settings-token/)
  } finally {
    again.child.kill('SIGTERM')
    shared.child.kill('SIGTERM')
  }
})

test('shapewall serve keeps the settings token out of output that is not a terminal (logs)', async () => {
  const home = settingsHome()
  const dir = tempDir('settings-serve-notty')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  const served = startServe(['--config', path.join(dir, 'shapewall.config.json')], {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: home.dir,
    HOME: home.dir,
  })
  try {
    const output = await served.ready
    assert.doesNotMatch(output, /settings-token/)
    assert.match(output, /Private owner link: not printed, because this output is not a terminal/)
  } finally {
    served.child.kill('SIGTERM')
  }
})
