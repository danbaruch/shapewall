// End to end, "What it can do": a real hosted server and three connected
// agents (solo, team and open fixtures: the summary their machines would
// send at hello, written to their rows), in Chromium at desktop 1440 and
// phone 390. The console card lists the same lines and states as
// `shapewall agent status --json` and the agent's own prompt block for the
// same machine policy; a line the project's setting holds says so; the
// board's agent panel shows the compact view; an older watcher nobody used
// is under API tokens, not Agents. Then a local board's owner sees its card.
// A fourth fixture names an agent config folder with a skill and an MCP
// server: its Extensions line is on, the same in all three places.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { LINE_LABELS, capabilitySummary, lineStates, toPrompt } from '../../src/agent/capability-render.js'
import { resolveCeiling } from '../../src/agent/capabilities.js'
import { agentStatusData } from '../../src/cli/agent-status.js'
import { saveMachinePolicy, readMachinePolicy } from '../../src/remote/agent-policy-file.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { saveUserAgentEntry } from '../../src/agent/user-settings.js'
import { policyExtensions } from '../../src/agent/agent-config-folder.js'
import { createProject, signUp, startHostedServer, writeLocalCaptures } from '../hosted-helpers.js'
import { sampleConfig, tempDir } from '../helpers.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const AGENT_SCOPES = ['read', 'reply', 'status', 'claim']
const PLATFORM = { os: 'linux', sandbox: true }
const POLICIES = {
  Solo: {
    audience: 'owner',
    approvals: 'owner',
    instructions: 'all',
    agentConfig: null,
    remote: 'origin',
    commands: [],
    shell: 'sandboxed',
    browser: 'on',
  },
  Team: {
    audience: 'server',
    approvals: 'admins',
    instructions: 'project',
    agentConfig: null,
    remote: null,
    commands: ['npm test'],
    trustTeam: 'members',
    shell: 'sandboxed',
    browser: 'on',
  },
  Open: {
    audience: 'server',
    approvals: 'none',
    instructions: 'none',
    agentConfig: null,
    remote: null,
    commands: [],
    shell: 'off',
    browser: 'off',
  },
}
POLICIES.Extended = { ...POLICIES.Solo, extensionsFor: ['owner'], allowTool: ['mcp__brain__search'] }
const TIER_OF = { Solo: 'solo', Team: 'team', Open: 'open', Extended: 'solo' }

// An agent config folder of this user's with one skill and one MCP server.
function extensionsFolder(name) {
  const dir = tempDir(name)
  fs.chmodSync(dir, 0o700)
  fs.mkdirSync(path.join(dir, 'skills', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'notes', 'SKILL.md'), '---\ndescription: Notes\n---\n')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { brain: { command: '/usr/bin/brain-mcp' } } }))
  return dir
}

// The agent's own prompt block as { id: state }.
function promptStates(text) {
  const out = {}
  let state = null
  for (const line of text.split('\n')) {
    if (/you can:$/.test(line)) state = 'on'
    else if (/^Only after a person answers/.test(line)) state = 'ask'
    else if (/^You cannot:/.test(line)) state = 'off'
    else if (/^To change this/.test(line)) state = null
    else if (state && line.startsWith('- ')) {
      const found = Object.entries(LINE_LABELS).find(([, label]) => line.startsWith(`- ${label}: `))
      if (found) out[found[0]] = state
    }
  }
  return out
}

let hosted
let browser
let ada
let ws
let project
let config
const contexts = []
const local = []
const policies = {}

const shot = async (page, name) => {
  if (!SHOTS) return
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))))
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' })
}
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const fresh = () => hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date().toISOString())

async function open({ width = 1440, height = 900, phone = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { isMobile: true, hasTouch: true } : {}) })
  contexts.push(context)
  await context.addCookies([...ada.browser.jar].map(([name, value]) => ({ name, value, url: hosted.origin })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(error.message))
  return { page, errors }
}

// A connected agent as its hello leaves it: a token with the agent scope, and the summary its machine sends.
async function connectedAgent(name) {
  fresh()
  const made = await ada.browser.post(consoleUrl('/tokens'), { name, scopes: AGENT_SCOPES })
  assert.equal(made.status, 201, made.text)
  const dir = tempDir(`cap-card-${name}`)
  const env = { XDG_CONFIG_HOME: path.join(dir, 'xdg'), XDG_STATE_HOME: path.join(dir, 'state'), HOME: dir }
  const given = name === 'Extended' ? { ...POLICIES[name], agentConfig: extensionsFolder('cap-card-ext') } : POLICIES[name]
  saveMachinePolicy(hosted.origin, 'default', given, env)
  const policy = readMachinePolicy(hosted.origin, 'default', env)
  const extensions = policyExtensions(policy.agentConfig, { projectDir: config.dir, outputDir: config.outputDir, env }).names
  if (name === 'Extended') assert.deepEqual(extensions, { skills: ['notes'], servers: ['brain'] })
  policies[name] = { env, policy, extensions }
  hosted.db
    .prepare('UPDATE api_tokens SET scopes = ? WHERE id = ?')
    .run(JSON.stringify([...AGENT_SCOPES, 'agent'].sort()), made.json.info.id)
  const summary = capabilitySummary({ machine: policy, config, platform: PLATFORM, extensions })
  hosted.db
    .prepare('UPDATE agents SET kind = ?, capabilities = ? WHERE token_id = ?')
    .run(
      'claude',
      JSON.stringify({ chat: true, policy: { audience: policy.audience, approvals: policy.approvals }, summary }),
      made.json.info.id,
    )
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the e2e tests')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  hosted = await startHostedServer('capability-card-e2e', { clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  project = await createProject(ada, ws, 'Site')
  fresh()
  const push = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  config = sampleConfig('capability-card-e2e-site')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: push.json.token })
  const begun = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(begun.id, area, name, fs.readFileSync(file))
  await remote.commitPush(begun.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
  for (const name of Object.keys(POLICIES)) await connectedAgent(name)
  // An older watcher nobody used in 100 days: hidden from Agents, listed under API tokens.
  const old = await ada.browser.post(consoleUrl('/tokens'), { name: 'Old watcher', scopes: AGENT_SCOPES })
  const long = new Date(Date.now() - 100 * 86400000).toISOString()
  hosted.db.prepare('UPDATE agents SET audience_inherited = 1, last_seen_at = ? WHERE token_id = ?').run(long, old.json.info.id)
  hosted.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(long, old.json.info.id)
  // The project keeps the shell off, so those lines say "limited by this project's setting".
  const set = await ada.browser.call('PUT', consoleUrl('/agent'), {
    body: { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false, dailyClaims: 1000, maxOpenClaims: 100, shell: false },
  })
  assert.equal(set.status, 200, set.text)
  browser = await chromium.launch()
})

after(async () => {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  await hosted?.close()
  for (const { app, server, setup } of local) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
    await setup.close()
  }
})

// The lines one card shows, as { id: state }.
const cardStates = (page, name, path, tier) =>
  page.evaluate(
    ([agent, where, which]) => {
      const card = document.querySelector(`[data-sw-capability-card="${agent}"]`)
      const list = card?.querySelector(`[data-sw-cap-path="${where}"][data-sw-cap-tier="${which}"]`)
      return list
        ? Object.fromEntries([...list.querySelectorAll('[data-sw-cap-line]')].map((li) => [li.dataset.swCapLine, li.dataset.state]))
        : null
    },
    [name, path, tier],
  )
async function choose(page, name, group, option) {
  await page.click(`[data-sw-capability-card="${name}"] [aria-label="${group}"] [data-sw-option="${option}"]`)
}

for (const width of [1440, 390])
  test(`console ${width}: each fixture agent's card lists what agent status and its prompt list; the project's setting says so`, async () => {
    const { page, errors } = await open({ width, height: width > 500 ? 900 : 844, phone: width < 500 })
    await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
    await page.waitForSelector('[data-sw-capability-card="Solo"] [data-sw-cap-line]')
    assert.ok(!(await page.locator('[data-sw-agent-row="Old watcher"]').count()), 'the older watcher is not listed')
    assert.equal(await page.getAttribute('[data-sw-agents-claim-tokens]', 'data-sw-agents-claim-tokens'), '1')
    for (const [name, tier] of Object.entries(TIER_OF)) {
      const { env, policy, extensions } = policies[name]
      const status = await agentStatusData({ remote: hosted.origin }, { env, cwd: config.dir, platform: PLATFORM })
      for (const [key, where] of [
        ['fix', 'hosted-fix', 'In Fix with'],
        ['chat', 'hosted-chat', 'In chat'],
      ]) {
        await choose(page, name, 'Where', key)
        await choose(page, name, 'Trust tier', tier)
        const shown = await cardStates(page, name, key, tier)
        const expected = lineStates(
          resolveCeiling(tier, {
            path: where,
            machine: policy,
            config,
            platform: PLATFORM,
            trust: { authors: [{ owner: true }], guests: false },
            extensions,
          }),
        )
        const fromStatus = Object.fromEntries(status.paths[key][tier].lines.map((line) => [line.id, line.state]))
        const prompt = toPrompt(
          resolveCeiling(tier, {
            path: where,
            machine: policy,
            config,
            platform: PLATFORM,
            trust: { authors: [{ owner: true }], guests: false },
            extensions,
          }),
        )
        if (name === 'Extended') assert.equal(expected.extensions, 'on', `${name} ${key} extensions`)
        else assert.equal(expected.extensions, 'off', `${name} ${key} extensions`)
        // The project keeps the shell off: commands and shell read off on the board, and say why.
        const narrowed = { ...expected, commands: 'off', shell: 'off' }
        assert.deepEqual(shown, narrowed, `${name} ${key} console`)
        assert.deepEqual({ ...fromStatus, commands: 'off', shell: 'off' }, narrowed, `${name} ${key} status`)
        assert.deepEqual(promptStates(prompt), expected, `${name} ${key} prompt`)
      }
    }
    const limited = page.locator('[data-sw-capability-card="Solo"] [data-sw-cap-line="shell"]')
    await choose(page, 'Solo', 'Where', 'fix')
    await choose(page, 'Solo', 'Trust tier', 'solo')
    assert.equal(await limited.getAttribute('data-narrowed'), 'true')
    assert.match(await limited.textContent(), /Limited by this project's setting/)
    assert.equal(await page.locator('[data-sw-capability-card="Solo"] [data-sw-cap-line="browser"]').getAttribute('data-state'), 'on')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
    if (width < 500) {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('[data-sw-capability-card] button')]
          .filter((el) => el.offsetParent !== null)
          .filter((el) => el.getBoundingClientRect().height < 43.99)
          .map((el) => el.textContent.trim().slice(0, 30)),
      )
      assert.deepEqual(small, [], 'touch targets under 44 px')
    }
    await page.locator('[data-sw-capability-card="Team"]').scrollIntoViewIfNeeded()
    await shot(page, `console-capabilities-${width}`)
    assert.deepEqual(errors, [])
  })

for (const width of [1440, 390])
  test(`API tokens ${width}: the older watcher is under "Has agent access (claim)"; Make this an agent lists it again`, async () => {
    const { page, errors } = await open({ width, height: width > 500 ? 900 : 844, phone: width < 500 })
    await page.goto(`${hosted.origin}/w/${ws}/tokens`)
    await page.waitForSelector('[data-sw-claim-token="Old watcher"]')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
    await shot(page, `tokens-claim-${width}`)
    if (width < 500) {
      await page.click('[data-sw-claim-make="Old watcher"]')
      await page.waitForSelector('[data-sw-claim-tokens]', { state: 'detached' })
      await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
      await page.waitForSelector('[data-sw-agent-row="Old watcher"]')
    }
    assert.deepEqual(errors, [])
  })

test('board 1440: the agent panel shows the compact lines for a fix you ask for', async () => {
  const { page, errors } = await open()
  await page.goto(`${hosted.origin}/w/${ws}/p/${project.id}/?board=sample&ha=1`)
  await page.waitForSelector('[data-sw-hosted-agent-name="Solo"] [data-sw-hosted-agent-can]')
  assert.equal(await page.getAttribute('[data-sw-hosted-agent-name="Solo"] [data-sw-hosted-agent-can]', 'data-sw-hosted-agent-can'), 'solo')
  assert.equal(await page.getAttribute('[data-sw-hosted-agent-name="Solo"] [data-sw-hosted-agent-can-line="edits"]', 'data-state'), 'ask')
  assert.equal(await page.getAttribute('[data-sw-hosted-agent-name="Solo"] [data-sw-hosted-agent-can-line="shell"]', 'data-state'), 'off')
  // Open's machine reads and answers only: no edits for anyone.
  assert.equal(await page.getAttribute('[data-sw-hosted-agent-name="Open"] [data-sw-hosted-agent-can-line="edits"]', 'data-state'), 'off')
  await shot(page, 'board-panel-capabilities-1440')
  assert.deepEqual(errors, [])
})

test('local board 1440 and 390: the owner sees the card; it lists what agent status lists', async () => {
  const setup = await demoSetup('capability-card-local')
  const home = tempDir('capability-card-local-home')
  // Claude Code is the board's agent: only it takes extensions.
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    PATH: path.dirname(process.execPath),
    SHAPEWALL_AGENT_ACP: 'npx @agentclientprotocol/claude-agent-acp',
  }
  saveUserAgentEntry(setup.config.dir, { capabilities: { browser: 'off' }, agentConfig: extensionsFolder('cap-card-local-ext') }, env)
  const app = createApp({ config: setup.config, env, settingsToken: 'cap-card-token-0123456789abcdef' })
  const server = await listen(app)
  local.push({ app, server, setup })
  const url = `http://127.0.0.1:${server.address().port}/`
  const status = await agentStatusData({}, { env, cwd: setup.config.dir })
  assert.equal(status.tiers.solo.lines.find((line) => line.id === 'extensions').state, 'on', 'the folder gives the owner extensions')
  assert.equal(status.tiers.open.lines.find((line) => line.id === 'extensions').state, 'off')
  const info = await (await fetch(`${url}api/info`)).json()
  assert.equal(info.agent?.capabilities, undefined, 'not for a browser without the owner link')
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) })
    contexts.push(context)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${url}#settings-token=cap-card-token-0123456789abcdef`)
    await page.waitForSelector('[data-sw-node="home"]')
    await page.goto(`${url}console?section=agents`)
    await page.waitForSelector('[data-sw-capability-card="local"] [data-sw-cap-line="browser"]')
    const card = page.locator('[data-sw-capability-card="local"]')
    for (const [tier] of [
      ['solo', 'Its owner'],
      ['open', 'Anyone else'],
    ]) {
      await choose(page, 'local', 'Trust tier', tier)
      const shown = await card.evaluate(
        (node, which) =>
          Object.fromEntries(
            [...node.querySelectorAll(`[data-sw-cap-tier="${which}"] [data-sw-cap-line]`)].map((li) => [
              li.dataset.swCapLine,
              li.dataset.state,
            ]),
          ),
        tier,
      )
      assert.deepEqual(shown, Object.fromEntries(status.tiers[tier].lines.map((line) => [line.id, line.state])), `local ${tier}`)
    }
    await choose(page, 'local', 'Trust tier', 'solo')
    assert.equal(await page.getAttribute('[data-sw-capability-card="local"] [data-sw-cap-line="browser"]', 'data-state'), 'off')
    assert.equal(
      (await page.textContent('[data-sw-capability-card="local"] [data-sw-cap-line="browser"] [data-sw-cap-fix]')).trim(),
      'shapewall agent set browser on',
    )
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
    await page.locator('[data-sw-capability-card="local"]').scrollIntoViewIfNeeded()
    await shot(page, `local-capabilities-${width}`)
    assert.deepEqual(errors, [])
  }
})
