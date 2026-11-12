// End to end, connected agents: a real hosted server, the real CLI running
// `shapewall agent connect` with the stub ACP agent as "Claude Code" on its
// PATH, and signed-in people in real browsers. The connection is approved
// on /device (named, given a face, an audience chosen); the agent shows as
// online on the board; a member chats with it and the answer streams; it
// refuses to write a file or run a command; Stop works; a reload mid-answer
// and a second person both see the running turn; an agent that is not
// yours says why; an offline agent takes no chat; the console lists what
// the agent is; and the whole chat works in the phone's sheet.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { createProject, invite, signUp, startHostedServer, writeLocalCaptures } from '../hosted-helpers.js'
import { ACP_STUB, connectAgent, startLink } from '../hosted-chat-helpers.js'
import { sampleConfig, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')

let hosted
let browser
let ada // the owner, who connects the agent
let cyd // a member
let ws
let project
let cli // the running `shapewall agent connect`
let scout // a second agent, Ada's own
const contexts = []
const links = []
const projectDir = tempDir('hosted-chat-e2e-code')

const shot = async (page, name) =>
  SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false, animations: 'disabled' })
const api = (user, method, url, body) => user.browser.call(method, url, body === undefined ? {} : { body })
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const boardPage = (query = '') => `${hosted.origin}/w/${ws}/p/${project.id}/?board=sample${query}`
const fresh = () => hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date().toISOString())

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function open(user, { width = 1440, height = 900, dark = false, phone = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: dark ? 'dark' : 'light',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  })
  contexts.push(context)
  await context.addCookies([...user.browser.jar].map(([name, value]) => ({ name, value, url: hosted.origin })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, page, errors }
}
const realErrors = (errors) => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

// The real command, as a person leaves it running where the code is. The
// stub ACP agent stands in for Claude Code's adapter on its PATH.
function startCli(extra = []) {
  const bin = tempDir('hosted-chat-e2e-bin')
  const adapter = path.join(bin, 'claude-agent-acp')
  fs.writeFileSync(adapter, `#!/bin/sh\nexec "${process.execPath}" "${ACP_STUB}" --ro-modes "$@"\n`, { mode: 0o755 })
  const child = spawn(process.execPath, [CLI, 'agent', 'connect', '--remote', hosted.origin, '--agent', 'claude', ...extra], {
    cwd: projectDir,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: tempDir('hosted-chat-e2e-home'),
      XDG_CONFIG_HOME: tempDir('hosted-chat-e2e-xdg'),
      SHAPEWALL_NO_BROWSER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { out: '', err: '' }
  child.stdout.on('data', (chunk) => (state.out += chunk))
  child.stderr.on('data', (chunk) => (state.err += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child,
    state,
    exited,
    // Ctrl+C, as a person stops it: the command lets go of its turns and exits 0.
    stop: async () => {
      child.kill('SIGTERM')
      return Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 15_000))])
    },
    close: () => stopChild(child, exited),
  }
}

const say = async (page, text) => {
  await page.fill('[data-sw-chat-input]', text)
  await page.click('[data-sw-chat-send]')
}
const lastAnswer = (page) => page.locator('[data-sw-chat-message="assistant"]').last()
const answered = (page, pattern, ms = 30_000) =>
  until(
    async () =>
      pattern.test(
        (await lastAnswer(page)
          .textContent()
          .catch(() => '')) || '',
      ),
    `an answer matching ${pattern}`,
    ms,
  )
const idle = (page) => page.waitForSelector('[data-sw-chat-send]', { timeout: 30_000 })
async function openAgents(page) {
  await page.goto(boardPage())
  await page.waitForSelector('[data-sw-chat-toggle]')
  await page.click('[data-sw-chat-toggle]')
  await page.waitForSelector('[data-sw-hosted-agent]')
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the hosted chat e2e test')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the hosted chat e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'The hero button is blue.\n')
  hosted = await startHostedServer('hosted-chat-e2e', { clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  fresh()
  const push = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  const config = sampleConfig('hosted-chat-e2e-site')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: push.json.token })
  const begun = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(begun.id, area, name, fs.readFileSync(file))
  await remote.commitPush(begun.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
  // Members may use an agent here (its audience still decides which).
  const policy = await api(ada, 'PUT', consoleUrl('/agent'), { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false })
  assert.equal(policy.status, 200, policy.text)
  browser = await chromium.launch()
})

after(async () => {
  await cli?.close()
  for (const entry of links) await entry.stop()
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  await hosted?.close()
})

test('connect: the command shows a code, an admin names the agent and approves it, and it comes online', async () => {
  const { page, errors } = await open(ada)
  // Before anything is connected, the Agents page leads with the command.
  await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
  await page.waitForSelector('[data-sw-connect-agent-chat]')
  assert.ok((await page.textContent('[data-sw-connect-agent-chat]')).includes(`shapewall agent connect --remote ${hosted.origin}`))
  await shot(page, 'console-connect-card-1440-light')

  cli = startCli(['--name', 'Builder'])
  await until(() => /[A-Z]{4}-[A-Z]{4}/.test(cli.state.out), `the code\n${cli.state.out}\n${cli.state.err}`)
  const code = /[A-Z]{4}-[A-Z]{4}/.exec(cli.state.out)[0]
  assert.match(cli.state.out, /To connect this agent, open/)
  assert.doesNotMatch(cli.state.out + cli.state.err, /swp_/, 'the token is never printed')

  await page.goto(`${hosted.origin}/device`)
  await page.fill('[data-sw-device-code]', code)
  await page.click('[data-sw-device-lookup]')
  await page.waitForSelector('[data-sw-device-agent]')
  assert.equal(await page.getAttribute('[data-sw-device-agent-kind]', 'data-sw-device-agent-kind'), 'claude')
  assert.equal(await page.inputValue('[data-sw-agent-name-input]'), 'Builder', 'the name the command suggested')
  assert.equal(await page.isChecked('[data-sw-device-agent-audience="owner"]'), true, 'only the approver, by default')
  assert.match(await page.textContent('[data-sw-device-agent]'), /does not change files and runs no commands/)
  await page.click('[data-sw-agent-icon-option="owl"]', { force: true })
  await shot(page, 'device-agent-1440-light')
  // Everyone the agent policy trusts, so a second person can use it below.
  await page.check('[data-sw-device-agent-audience="trusted"]')
  fresh()
  await page.click('[data-sw-device-approve]')
  await page.waitForSelector('[data-sw-device-done="approved"]')
  assert.match(await page.textContent('[data-sw-device-agent-done]'), /reads the project and answers/)
  await shot(page, 'device-agent-done-1440-light')

  await until(() => /Connected: Builder/.test(cli.state.err), `the link\n${cli.state.out}\n${cli.state.err}`)
  assert.match(cli.state.err, /No edits, no commands/)
  assert.doesNotMatch(cli.state.out + cli.state.err, /swp_/)
  const agents = (await ada.browser.get(consoleUrl('/agents'))).json.agents
  const builder = agents.find((agent) => agent.name === 'Builder')
  assert.equal(builder.state, 'online')
  assert.equal(builder.kind, 'claude')
  assert.equal(builder.icon, 'owl')
  assert.equal(builder.audience.kind, 'trusted')
  assert.deepEqual(builder.token.scopes.sort(), ['agent', 'claim', 'read', 'reply', 'status'])

  // The console shows what it is.
  await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
  await page.waitForSelector('[data-sw-agent-row="Builder"] [data-sw-agent-link="open"]')
  const row = await page.textContent('[data-sw-agent-row="Builder"]')
  assert.match(row, /Claude Code/)
  assert.match(row, /Chats on the board, reads and answers only/)
  assert.match(row, /connected since/)
  await shot(page, 'console-agents-connected-1440-light')
  await page.goto(`${hosted.origin}/w/${ws}/agents`)
  await page.waitForSelector('[data-sw-overview-agent="Builder"] [data-sw-overview-connected]')
  assert.match(await page.textContent('[data-sw-overview-agent="Builder"]'), /Claude Code/)
  await shot(page, 'console-agents-overview-1440-light')
  assert.deepEqual(realErrors(errors), [])
})

test('chat: pick the agent in the Agents panel, ask, and the answer streams in; it survives a reload', async () => {
  const { page, errors } = await open(ada)
  await openAgents(page)
  const row = page.locator('[data-sw-hosted-agent-name="Builder"]')
  await row.waitFor()
  assert.equal(await row.getAttribute('data-sw-agent-state'), 'online')
  assert.match(await row.textContent(), /Reads and answers\. No edits, no commands\./)
  await shot(page, 'board-agents-panel-1440-light')
  await row.locator('[data-sw-hosted-agent-chat]').click()
  await page.waitForSelector('[data-sw-chat-input]')
  assert.equal(await page.getAttribute('[data-sw-chat-label]', 'data-sw-chat-label'), 'Builder')
  await say(page, 'stream')
  await answered(page, /\S{3,}/)
  await idle(page)
  const text = await lastAnswer(page).textContent()
  await shot(page, 'board-chat-answer-1440-light')
  // History is the server's: a reload shows the same conversation.
  await page.reload()
  await page.waitForSelector('[data-sw-chat-message="assistant"]')
  assert.equal(await page.locator('[data-sw-chat-message="user"]').count(), 1)
  assert.ok((await lastAnswer(page).textContent()).includes(text.trim().slice(0, 20)))
  assert.deepEqual(realErrors(errors), [])
})

test('read and answer only: a file write and a command are refused on the machine, and the thread says so', async () => {
  const { page } = await open(ada)
  await openAgents(page)
  await page.locator('[data-sw-hosted-agent-name="Builder"] [data-sw-hosted-agent-chat]').click()
  await page.waitForSelector('[data-sw-chat-input]')
  await say(page, 'write refused.txt')
  await answered(page, /reads and answers only/)
  await idle(page)
  assert.equal(fs.existsSync(path.join(projectDir, 'refused.txt')), false, 'nothing was written')
  assert.equal(await page.locator('[data-sw-permission-allow], [data-sw-chat-permission-allow]').count(), 0, 'no card to answer')
  await shot(page, 'board-chat-refused-1440-light')
  await say(page, `run ${process.execPath} -e require('fs').writeFileSync('ran.txt','x')`)
  await answered(page, /reads and answers only/)
  await idle(page)
  assert.equal(fs.existsSync(path.join(projectDir, 'ran.txt')), false, 'nothing ran')
})

test('Stop ends a running answer; a reload mid-answer joins it again', async () => {
  const { page } = await open(ada)
  await openAgents(page)
  await page.locator('[data-sw-hosted-agent-name="Builder"] [data-sw-hosted-agent-chat]').click()
  await page.waitForSelector('[data-sw-chat-input]')
  await say(page, 'slowly')
  await page.waitForSelector('[data-sw-chat-stop]')
  await answered(page, /\S/)
  await page.reload()
  // Still running: the reloaded tab joins the same turn and can stop it.
  await page.waitForSelector('[data-sw-chat-stop]', { timeout: 20_000 })
  await answered(page, /\S/)
  await page.click('[data-sw-chat-stop]')
  await idle(page)
  await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"]')
  // And the next question is taken: one turn at a time, then free again.
  await say(page, 'stream')
  await answered(page, /\S{3,}/)
  await idle(page)
})

test('two people on the board chat: the second sees the question and the answer as it is written', async () => {
  const one = await open(ada)
  const two = await open(cyd)
  await one.page.goto(boardPage('&chat=board&ha=1'))
  await two.page.goto(boardPage('&chat=board&ha=1'))
  await one.page.waitForSelector('[data-sw-chat-input]')
  await two.page.waitForSelector('[data-sw-chat-input]')
  await say(one.page, 'slowly')
  await one.page.waitForSelector('[data-sw-chat-stop]')
  // Cyd did not send it, and sees it running.
  await two.page.waitForSelector('[data-sw-chat-message="user"]', { timeout: 20_000 })
  await two.page.waitForSelector('[data-sw-chat-stop]', { timeout: 20_000 })
  await answered(two.page, /\S/)
  await shot(two.page, 'board-chat-second-viewer-1440-light')
  // A member who did not ask does not stop it; the person who asked does.
  const refused = await cyd.browser.post(`/w/${ws}/p/${project.id}/api/agent/boards/sample/threads/board/stop`, {})
  assert.equal(refused.status, 403, refused.text)
  await one.page.click('[data-sw-chat-stop]')
  await idle(one.page)
  await idle(two.page)
  await two.page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"]')
  // Cyd is in Builder's audience (everyone the policy trusts): Cyd asks too.
  await say(two.page, 'stream')
  await answered(two.page, /\S{3,}/)
  await answered(one.page, /\S{3,}/)
  assert.deepEqual(realErrors(one.errors), [])
  assert.deepEqual(realErrors(two.errors), [])
})

test("an agent that is someone else's own: listed, with the reason it cannot be used", async () => {
  scout = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Scout', kind: 'codex', machine: 'laptop' })
  assert.equal(scout.status, 200, JSON.stringify(scout.error))
  const link = startLink(hosted, scout.token, { kind: 'codex' })
  links.push(link)
  assert.ok(await link.ready)
  const { page } = await open(cyd)
  await openAgents(page)
  const row = page.locator('[data-sw-hosted-agent-name="Scout"]')
  await row.waitFor()
  assert.equal(await row.locator('[data-sw-hosted-agent-chat]').isDisabled(), true)
  assert.match(await row.textContent(), /Only Ada can use Scout/)
  await shot(page, 'board-agents-not-yours-1440-light')
})

test('dark, and the phone: the Agents sheet, then the chat in its sheet', async () => {
  const dark = await open(ada, { dark: true })
  await openAgents(dark.page)
  await dark.page.locator('[data-sw-hosted-agent-name="Builder"]').waitFor()
  await shot(dark.page, 'board-agents-panel-1440-dark')
  await dark.page.locator('[data-sw-hosted-agent-name="Builder"] [data-sw-hosted-agent-chat]').click()
  await dark.page.waitForSelector('[data-sw-chat-input]')
  await say(dark.page, 'tools')
  await answered(dark.page, /\S{3,}/)
  await idle(dark.page)
  await shot(dark.page, 'board-chat-answer-1440-dark')
  await dark.page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
  await dark.page.waitForSelector('[data-sw-agent-row="Builder"]')
  await shot(dark.page, 'console-agents-connected-1440-dark')

  const { page, errors } = await open(ada, { width: 390, height: 844, phone: true })
  await page.goto(boardPage())
  await page.waitForSelector('[data-sw-menu]')
  await page.tap('[data-sw-menu]')
  await page.tap('[data-sw-hosted-agent-open]')
  await page.waitForSelector('[data-sw-hosted-agent-sheet]')
  await page.locator('[data-sw-hosted-agent-name="Builder"]').waitFor()
  await shot(page, 'board-agents-sheet-390-light')
  await page.locator('[data-sw-hosted-agent-name="Builder"] [data-sw-hosted-agent-chat]').tap()
  await page.waitForSelector('[data-sw-chat-input]')
  await page.fill('[data-sw-chat-input]', 'stream')
  await page.tap('[data-sw-chat-send]')
  await answered(page, /\S{3,}/)
  await idle(page)
  await shot(page, 'board-chat-sheet-390-light')
  assert.deepEqual(realErrors(errors), [])

  const device = await open(ada, { width: 390, height: 844, phone: true })
  await device.page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
  await device.page.waitForSelector('[data-sw-agent-row="Builder"]')
  await shot(device.page, 'console-agents-connected-390-light')
  await device.page.goto(`${hosted.origin}/w/${ws}/agents`)
  await device.page.waitForSelector('[data-sw-overview-agent="Builder"]')
  await shot(device.page, 'console-agents-overview-390-light')
  await dark.page.goto(`${hosted.origin}/w/${ws}/agents`)
  await dark.page.waitForSelector('[data-sw-overview-agent="Builder"]')
  await shot(dark.page, 'console-agents-overview-1440-dark')

  // The approval page for a connection, dark and on a phone (then denied).
  const started = await (
    await fetch(`${hosted.origin}/api/v1/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'studio', purpose: 'agent', agent: { kind: 'codex', name: 'Scout' } }),
    })
  ).json()
  for (const [view, name] of [
    [dark.page, 'device-agent-1440-dark'],
    [device.page, 'device-agent-390-light'],
  ]) {
    await view.goto(`${hosted.origin}/device`)
    await view.fill('[data-sw-device-code]', started.userCode)
    await view.click('[data-sw-device-lookup]')
    await view.waitForSelector('[data-sw-device-agent]')
    assert.equal(await view.inputValue('[data-sw-agent-name-input]'), 'Scout')
    await shot(view, name)
  }
  assert.equal(
    await device.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    'no sideways scroll on a phone',
  )
  await device.page.click('[data-sw-device-deny]')
  await device.page.waitForSelector('[data-sw-device-done="denied"]')
})

test('offline: stopping the command takes the agent offline at once, and chat says so instead of sending', async () => {
  const { page } = await open(ada)
  await openAgents(page)
  await page.locator('[data-sw-hosted-agent-name="Builder"] [data-sw-hosted-agent-chat]').click()
  await page.waitForSelector('[data-sw-chat-input]')
  const closed = await cli.stop()
  assert.equal(closed.code, 0, `a clean exit\n${cli.state.err}`)
  assert.match(cli.state.err, /Disconnected\./)
  cli = null
  await page.waitForSelector('[data-sw-chat-blocked="agent_offline"]', { timeout: 30_000 })
  assert.match(await page.textContent('[data-sw-chat-blocked]'), /Builder is offline/)
  assert.equal(await page.locator('[data-sw-chat-input]').count(), 0)
  await shot(page, 'board-chat-offline-1440-light')
  const sent = await ada.browser.post(`/w/${ws}/p/${project.id}/api/agent/boards/sample/threads/board/messages`, { text: 'hello' })
  assert.equal(sent.status, 409, sent.text)
  assert.equal(sent.json.error.code, 'agent_offline')
  // Never handed to another agent silently: Scout (online, Ada's own) is offered, and choosing it is said in the thread.
  await say2(page)
})
// In a chat with messages whose agent went offline: "Ask Scout instead", then the switch shows and Scout answers.
async function say2(page) {
  await page.goto(boardPage('&chat=board&ha=1'))
  await page.waitForSelector('[data-sw-chat-blocked="agent_offline"]')
  assert.equal(await page.getAttribute('[data-sw-chat-label]', 'data-sw-chat-label'), 'Builder', "still Builder's chat")
  const other = page.locator('[data-sw-chat-ask-other]')
  assert.match(await other.textContent(), /Ask Scout instead/)
  await shot(page, 'board-chat-offline-ask-other-1440-light')
  await other.click()
  await page.waitForSelector('[data-sw-chat-input]')
  assert.equal(await page.getAttribute('[data-sw-chat-label]', 'data-sw-chat-label'), 'Scout')
  await until(
    async () => /Ada switched this chat from Builder to Scout/.test(await page.textContent('[data-sw-chat]')),
    'the line that says the agent changed',
  )
  await say(page, 'stream')
  await answered(page, /Hello from the stream/)
  await idle(page)
  await shot(page, 'board-chat-switched-1440-light')
}
