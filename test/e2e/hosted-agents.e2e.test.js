// End to end, hosted agents: a real hosted server, two signed-in people in
// real browsers (the owner and a member), and two real `shapewall watch
// --remote --exec` watchers, each with its own project token. The board
// lists the agents with their state; a comment sent to one agent runs only
// on that watcher; a comment for an offline agent waits and is released to
// any agent; an audience keeps a member out and says why; the default
// agent; a rename and an icon show on the agent's reply; the console's
// Agents page and the workspace overview; and the phone's Agents sheet.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { createProject, invite, signUp, startHostedServer, tokenCall, writeLocalCaptures } from '../hosted-helpers.js'
import { sampleConfig, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')
const TOUCH = path.join(ROOT_DIR, 'test', 'fixtures', 'agent-touch.mjs')
const AGENT_SCOPES = ['read', 'reply', 'status', 'claim']

let hosted
let browser
let ada // the owner
let cyd // a member
let ws
let project
let builder // { token, id, agentId }: shared with everyone the policy trusts
let scout // { token, id, agentId }: Ada's own, first called Fixer
const watchers = []
const contexts = []
const ranFile = path.join(tempDir('hosted-agents-e2e-ran'), 'ran.txt')
const ran = () => fs.readFileSync(ranFile, 'utf8').trim().split('\n').filter(Boolean)

const shot = async (page, name) =>
  SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false, animations: 'disabled' })
const api = (user, method, url, body) => user.browser.call(method, url, body === undefined ? {} : { body })
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const boardApi = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const boardPage = (query = '') => `${hosted.origin}/w/${ws}/p/${project.id}/?board=sample${query}`
// Admin changes ask for a passkey check in the last ten minutes: the test
// accounts signed up moments ago, and this keeps them fresh.
const fresh = () => hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date().toISOString())

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// A browser signed in as `user` (the session the API sign-up made).
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

// The real CLI, as a person would leave it running on the machine with the code.
function watch(agent, label, { ms = 0 } = {}) {
  const child = spawn(
    process.execPath,
    [CLI, 'watch', '--remote', hosted.origin, '--board', 'sample', '--exec', `${process.execPath} ${TOUCH}`],
    {
      cwd: tempDir(`hosted-agents-e2e-${label}`),
      env: {
        ...process.env,
        SHAPEWALL_NO_BROWSER: '1',
        XDG_CONFIG_HOME: tempDir(`hosted-agents-e2e-xdg-${label}`),
        SHAPEWALL_TOKEN: agent.token,
        SW_TOUCH_FILE: ranFile,
        SW_TOUCH_LABEL: label,
        SW_TOUCH_MS: String(ms),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const state = { stderr: '' }
  child.stderr.on('data', (chunk) => (state.stderr += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const entry = { child, state, label, close: () => stopChild(child, exited) }
  watchers.push(entry)
  return entry
}
const started = (entry) => until(() => /Watching hosted board/.test(entry.state.stderr), `${entry.label} to start\n${entry.state.stderr}`)

async function makeAgent(name) {
  fresh()
  const made = await ada.browser.post(consoleUrl('/tokens'), { name, scopes: AGENT_SCOPES })
  assert.equal(made.status, 201, made.text)
  const agents = (await ada.browser.get(consoleUrl('/agents'))).json.agents
  return { token: made.json.token, id: made.json.info.id, agentId: agents.find((agent) => agent.name === name).id }
}
async function comment(user, body, x = 20) {
  const made = await user.browser.post(boardApi('/comments'), { pageId: 'home', viewport: 'desktop', x, y: 20, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
// A comment nobody sent yet: editing one clears its vouch.
async function unsent(user, body, x) {
  const made = await comment(user, `${body} (draft)`, x)
  const edited = await api(user, 'PATCH', boardApi(`/comments/${made.id}`), { body })
  assert.equal(edited.status, 200, edited.text)
  assert.equal(edited.json.comment.dispatchable, false)
  return edited.json.comment
}
const seen = async (id) => (await ada.browser.get(boardApi('/comments'))).json.comments.find((item) => item.id === id)

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the hosted agents e2e test')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the hosted agents e2e test')
  fs.writeFileSync(ranFile, '')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  hosted = await startHostedServer('hosted-agents-e2e', { clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  fresh()
  const push = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  const config = sampleConfig('hosted-agents-e2e-site')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: push.json.token })
  const begun = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(begun.id, area, name, fs.readFileSync(file))
  await remote.commitPush(begun.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
  // Members may send work to an agent here, without an admin's OK per run.
  const policy = await api(ada, 'PUT', consoleUrl('/agent'), {
    trustedRoles: ['member', 'admin', 'owner'],
    approveNonAdmin: false,
    dailyClaims: 1000,
    maxOpenClaims: 100,
  })
  assert.equal(policy.status, 200, policy.text)
  browser = await chromium.launch()
})

after(async () => {
  for (const entry of watchers) await entry.close()
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close()
  await hosted?.close()
})

test('the console: a project with no agent says how to connect one; then each agent with its state, audience and approvals', async () => {
  const { page, errors } = await open(ada)
  await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
  await page.waitForSelector('[data-sw-project-agents]')
  await page.waitForSelector('text=No agent is connected to this project')
  const connect = await page.textContent('[data-sw-connect-agent]')
  assert.ok(connect.includes(`shapewall login --remote ${hosted.origin}`), 'this server in the command')
  assert.ok(connect.includes(`shapewall watch --remote ${hosted.origin} --exec`))
  assert.equal(
    await page.getAttribute('[data-sw-connect-agent-docs]', 'href'),
    'https://shapewall.com/docs/hosted#agents-on-a-hosted-board',
  )
  await shot(page, 'console-agents-1-empty-1440-light')

  builder = await makeAgent('Builder')
  scout = await makeAgent('Fixer')
  await page.reload()
  await page.waitForSelector('[data-sw-agent-row="Builder"]')
  const row = page.locator('[data-sw-agent-row="Fixer"]')
  assert.equal(await row.locator('[data-sw-agent-state]').first().getAttribute('data-sw-agent-state'), 'offline')
  assert.match(await row.textContent(), /Never connected/)
  assert.match(await row.locator('[data-sw-agent-audience]').textContent(), /Only Ada/)
  assert.match(await row.locator('[data-sw-agent-approval]').textContent(), /Ask every time/)
  // A watcher whose command is unknown wears its initials.
  assert.equal(await row.locator('[data-sw-agent-avatar]').first().getAttribute('data-sw-agent-avatar'), 'initials')

  // Rename it and give it a face, with the editor the local Agents page uses.
  await page.click('[data-sw-agent-edit="Fixer"]')
  await page.waitForSelector('[data-sw-agent-edit-dialog]')
  await page.fill('[data-sw-agent-name-input]', 'Scout')
  await page.click('[data-sw-agent-icon-option="owl"]', { force: true })
  await shot(page, 'console-agents-2-edit-1440-light')
  await page.click('[data-sw-agent-edit-save]')
  await page.waitForSelector('[data-sw-agent-row="Scout"]')
  assert.equal(await page.locator('[data-sw-agent-row="Scout"] [data-sw-agent-avatar]').first().getAttribute('data-sw-agent-avatar'), 'owl')

  // Builder is for the team: everyone the agent policy trusts. Saving asks
  // for a passkey check in the last ten minutes (the session is fresh).
  fresh()
  await page.click('[data-sw-agent-audience-edit="Builder"]')
  await page.waitForSelector('[data-sw-agent-audience-dialog]')
  await page.click('[data-sw-agent-audience-option="members"]')
  await page.waitForSelector('[data-sw-agent-audience-member="cyd"]')
  await shot(page, 'console-agents-3-audience-1440-light')
  await page.click('[data-sw-agent-audience-option="trusted"]')
  await page.click('[data-sw-agent-audience-save]')
  await page.waitForSelector('[data-sw-agent-row="Builder"] [data-sw-agent-audience="trusted"]')

  // The approval rule: always ask; automatic is listed as not available, with why.
  await page.click('[data-sw-agent-approval-edit="Builder"]')
  await page.waitForSelector('[data-sw-agent-approval-dialog]')
  assert.equal(await page.getAttribute('[data-sw-agent-approval-option="ask"]', 'aria-checked'), 'true')
  assert.equal(await page.getAttribute('[data-sw-agent-approval-option="auto"]', 'aria-disabled'), 'true')
  assert.match(await page.textContent('[data-sw-agent-approval-unavailable]'), /Allow without asking \(not available\)/)
  assert.match(await page.textContent('[data-sw-agent-approval-why]'), /takes comments on its own and asks before each command/)
  await shot(page, 'console-agents-4-approval-1440-light')
  await page.keyboard.press('Escape')

  // The default agent.
  await page.click('[data-sw-agent-make-default="Builder"]')
  await page.waitForSelector('[data-sw-agent-row="Builder"] [data-sw-agent-default]')
  assert.equal(await page.locator('[data-sw-agent-row="Scout"] [data-sw-agent-default]').count(), 0)
  await shot(page, 'console-agents-5-list-1440-light')
  assert.doesNotMatch(await page.textContent('main'), /\bnull\b|\bundefined\b|NaN/)

  // The project page points here.
  await page.goto(`${hosted.origin}/w/${ws}/projects/${project.id}`)
  await page.waitForSelector('[data-sw-project-agents-card] [data-sw-project-agent="Scout"]')
  assert.match(await page.getAttribute('[data-sw-project-agents-open]', 'href'), new RegExp(`/w/${ws}/agents/${project.id}$`))
  assert.deepEqual(errors, [])
})

test('the workspace overview: every agent, the project it serves, its state and audience, with a way to manage each', async () => {
  const docs = await createProject(ada, ws, 'Docs')
  const { page, errors } = await open(ada)
  await page.goto(`${hosted.origin}/w/${ws}`)
  await page.click('[data-sw-nav="agents"]')
  await page.waitForSelector('[data-sw-agents-overview] [data-sw-overview-agent="Builder"]')
  const row = page.locator('[data-sw-overview-agent="Scout"]')
  assert.equal(await row.getAttribute('data-sw-overview-project'), 'Site')
  assert.match(await row.textContent(), /Only Ada/)
  assert.match(await row.textContent(), /Offline/)
  assert.match(await page.locator('[data-sw-overview-agent="Builder"]').textContent(), /Everyone this project's agent policy trusts/)
  // A project nobody serves is listed too, with the way to connect one.
  assert.equal(await page.locator('[data-sw-agents-without] [data-sw-overview-connect="Docs"]').count(), 1)
  await shot(page, 'console-overview-1440-light')
  await page.click('[data-sw-overview-manage="Scout"]')
  await page.waitForSelector('[data-sw-agent-row="Scout"]')
  assert.ok(page.url().endsWith(`/w/${ws}/agents/${project.id}`))
  // A member has no Agents page.
  const member = await open(cyd)
  await member.page.goto(`${hosted.origin}/w/${ws}`)
  await member.page.waitForSelector('[data-sw-nav="projects"]')
  assert.equal(await member.page.locator('[data-sw-nav="agents"]').count(), 0)
  await member.page.goto(`${hosted.origin}/w/${ws}/agents`)
  await member.page.waitForSelector('[data-sw-needs-role="admin"]')
  assert.deepEqual(errors, [])
  assert.ok(docs.id)
})

test('the board lists the agents with their state; the toolbar says which are online', async () => {
  const { page, errors } = await open(ada)
  await page.goto(boardPage('&ha=1'))
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForSelector('[data-sw-rail="agent"] [data-sw-hosted-agent]')
  await page.waitForSelector('[data-sw-hosted-agent-row]')
  assert.equal(await page.getAttribute('[data-sw-hosted-agent-listening]', 'data-sw-hosted-agent-listening'), 'none')
  assert.match(await page.textContent('[data-sw-hosted-agent-listening]'), /No agent is online/)
  const agent = '[data-sw-toolbar="full"] [data-sw-panel-switch] [data-sw-chat-toggle]'
  assert.match(await page.getAttribute(agent, 'aria-label'), /No agent is online: comments wait until one is/)
  const rows = page.locator('[data-sw-hosted-agent-row]')
  assert.deepEqual(await rows.evaluateAll((list) => list.map((item) => [item.dataset.swHostedAgentName, item.dataset.swAgentState])), [
    ['Builder', 'offline'],
    ['Scout', 'offline'],
  ])
  await shot(page, 'board-panel-1-offline-1440-light')

  // Builder's machine starts watching: the real CLI, unchanged.
  await started(watch(builder, 'builder'))
  await page.reload()
  await page.waitForSelector('[data-sw-hosted-agent-row][data-sw-hosted-agent-name="Builder"][data-sw-agent-state="online"]')
  assert.equal(await page.getAttribute('[data-sw-hosted-agent-listening]', 'data-sw-hosted-agent-listening'), 'online')
  const builderRow = page.locator('[data-sw-hosted-agent-name="Builder"]')
  assert.match(await builderRow.textContent(), /Online/)
  assert.equal(await builderRow.locator('[data-sw-agent-default]').count(), 1)
  assert.match(await builderRow.locator('[data-sw-hosted-agent-audience]').textContent(), /everyone this project's agent policy trusts/)
  const scoutRow = page.locator('[data-sw-hosted-agent-name="Scout"]')
  assert.match(await scoutRow.textContent(), /Offline, never connected/)
  assert.equal(await scoutRow.locator('[data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'), 'owl')
  assert.match(await page.getAttribute(agent, 'aria-label'), /Builder online, Scout offline/)
  assert.match(await page.getAttribute('[data-sw-hosted-agent-manage]', 'href'), new RegExp(`/w/${ws}/agents/${project.id}$`))
  // Nothing about a token reaches the board.
  assert.doesNotMatch(await page.content(), /swp_|tk_[a-f0-9]{24}/)
  await shot(page, 'board-panel-2-online-1440-light')
  assert.deepEqual(errors, [])
})

test('an audience keeps a member out and says why; Send to <default agent> runs on that watcher only', async () => {
  const mine = await unsent(cyd, 'Tighten the heading', 30)
  const { page, errors } = await open(cyd)
  await page.goto(boardPage(`&c=${mine.id}`))
  await page.waitForSelector(`[data-sw-thread-popover="${mine.id}"]`)
  // The main part names the default agent; the caret lists them all.
  const main = `[data-sw-send-agent="${mine.id}"]`
  await page.waitForSelector(main)
  assert.equal((await page.textContent(main)).trim(), 'Send to Builder')
  assert.equal(await page.getAttribute(main, 'data-sw-send-agent-target'), builder.agentId)
  await page.click(`[data-sw-send-agent-choose="${mine.id}"]`)
  await page.waitForSelector('[data-sw-send-agent-menu]')
  const options = page.locator('[data-sw-send-agent-option]')
  assert.deepEqual(
    await options.evaluateAll((list) => list.map((item) => item.dataset.swSendAgentName || item.dataset.swSendAgentOption)),
    ['Builder', 'Scout', 'any'],
  )
  const blocked = page.locator('[data-sw-send-agent-name="Scout"]')
  assert.equal(await blocked.getAttribute('data-sw-send-agent-blocked'), 'true')
  assert.equal(await blocked.getAttribute('aria-disabled'), 'true')
  assert.match(await blocked.locator('[data-sw-send-agent-line]').textContent(), /Only Ada can send work to Scout/)
  assert.match(await page.locator('[data-sw-send-agent-name="Builder"]').textContent(), /Default/)
  assert.match(await page.locator('[data-sw-send-agent-name="Builder"] [data-sw-send-agent-line]').textContent(), /Online/)
  await shot(page, 'board-send-menu-1440-light')
  // The server refuses it as well, whatever the page offers.
  const forced = await cyd.browser.post(boardApi(`/comments/${mine.id}/send-to-agent`), {
    dispatchHash: (await cyd.browser.get(boardApi('/comments'))).json.comments.find((item) => item.id === mine.id).dispatchHash,
    agentId: scout.agentId,
  })
  assert.equal(forced.status, 403)
  assert.equal(forced.json.error.code, 'agent_audience')
  await page.keyboard.press('Escape')

  await page.click(main)
  await until(() => ran().includes(`builder sample#${mine.id}`), "Builder's command to run")
  await until(async () => (await seen(mine.id)).agentStatus === 'done', 'done')
  assert.deepEqual(ran(), [`builder sample#${mine.id}`], 'one run, on the watcher it was sent to')
  assert.deepEqual(errors, [])
})

test('a comment for an offline agent waits with a visible state; "Let any agent take it" hands it over', async () => {
  const waiting = await unsent(ada, 'Scout should look at this', 40)
  const { page, errors } = await open(ada)
  await page.goto(boardPage(`&c=${waiting.id}&ha=1`))
  await page.waitForSelector(`[data-sw-thread-popover="${waiting.id}"]`)
  await page.click(`[data-sw-send-agent-choose="${waiting.id}"]`)
  await page.click('[data-sw-send-agent-name="Scout"]')
  await page.waitForSelector('[data-sw-sent-agent="waiting"]')
  assert.match(await page.textContent('[data-sw-sent-agent="waiting"]'), /^Waiting for Scout \(offline, never connected\)$/)
  // The panel says the same under Scout.
  const queued = page.locator('[data-sw-hosted-agent-name="Scout"] [data-sw-hosted-agent-comments="queued"]')
  await queued.waitFor()
  assert.match(await queued.textContent(), new RegExp(`Waiting for it\\s*#${waiting.id}`))
  await shot(page, 'board-waiting-1440-light')
  // Builder is online and does not take what was sent to Scout.
  await new Promise((resolve) => setTimeout(resolve, 3500))
  assert.equal((await seen(waiting.id)).agentStatus, null)
  assert.ok(!ran().some((line) => line.endsWith(`#${waiting.id}`)))

  await page.click(`[data-sw-release-agent="${waiting.id}"]`)
  await until(() => ran().includes(`builder sample#${waiting.id}`), 'Builder to take the released comment')
  await until(async () => (await seen(waiting.id)).agentStatus === 'done', 'done')
  const audit = (await ada.browser.get(`/api/workspaces/${ws}/audit?action=agent_queue_released`)).json.entries
  assert.equal(audit[0].target, `sample#${waiting.id}`)
  assert.deepEqual(errors, [])
})

test('sent to a named agent, only that watcher gets it; its reply wears its new name and icon; the default takes new comments', async () => {
  // Scout's machine comes up, with a command that takes a few seconds.
  await started(watch(scout, 'scout', { ms: 4000 }))
  const forScout = await unsent(ada, 'Only Scout', 50)
  const { page, errors } = await open(ada)
  await page.goto(boardPage(`&c=${forScout.id}&ha=1`))
  await page.waitForSelector(`[data-sw-thread-popover="${forScout.id}"]`)
  await page.waitForSelector('[data-sw-hosted-agent-name="Scout"][data-sw-agent-state="online"]')
  await page.click(`[data-sw-send-agent-choose="${forScout.id}"]`)
  await page.click('[data-sw-send-agent-name="Scout"]')
  // While it works: the thread and the panel say who has it.
  await page.waitForSelector('[data-sw-sent-agent="working"]', { timeout: 20_000 })
  assert.match(await page.textContent('[data-sw-sent-agent="working"]'), /Scout is working on this/)
  await page.waitForSelector('[data-sw-hosted-agent-name="Scout"][data-sw-agent-state="busy"]', { timeout: 20_000 })
  assert.match(await page.locator('[data-sw-hosted-agent-name="Scout"]').textContent(), new RegExp(`Working on #${forScout.id}`))
  await shot(page, 'board-panel-3-working-1440-light')
  // The agent answers on the thread (its token, as a wrapper script would).
  const reply = await tokenCall(hosted, scout.token, 'POST', `/api/v1/boards/sample/comments/${forScout.id}/replies`, {
    body: { body: 'Fixed the heading.' },
  })
  assert.equal(reply.status, 201, reply.text)
  await until(async () => (await seen(forScout.id)).agentStatus === 'done', 'Scout to finish')
  assert.deepEqual(
    ran().filter((line) => line.endsWith(`#${forScout.id}`)),
    [`scout sample#${forScout.id}`],
    'the other watcher never ran it',
  )
  await page.reload()
  const message = page.locator(`[data-sw-thread-popover="${forScout.id}"] [data-sw-reply]`).first()
  await message.waitFor()
  assert.match(await message.textContent(), /Scout/)
  assert.equal(await message.locator('[data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'), 'owl')
  await shot(page, 'board-reply-1440-light')

  // The default agent: Ada's new comment goes to Builder, not to Scout.
  const latest = await comment(ada, 'A new comment from a trusted member', 60)
  assert.equal(latest.agentId, builder.agentId)
  await until(() => ran().some((line) => line.endsWith(`#${latest.id}`)), 'the default agent to run it')
  assert.deepEqual(
    ran().filter((line) => line.endsWith(`#${latest.id}`)),
    [`builder sample#${latest.id}`],
  )
  for (const entry of watchers) assert.equal(entry.child.exitCode, null, `${entry.label} still runs\n${entry.state.stderr}`)
  assert.deepEqual(errors, [])
})

test('dark: the panel and the split control', async () => {
  const draft = await unsent(ada, 'For the dark screenshot', 70)
  const { page, errors } = await open(ada, { dark: true })
  await page.goto(boardPage(`&c=${draft.id}&ha=1`))
  await page.waitForSelector('[data-sw-hosted-agent-row]')
  await page.waitForSelector(`[data-sw-send-agent="${draft.id}"]`)
  await shot(page, 'board-panel-1440-dark')
  await page.click(`[data-sw-send-agent-choose="${draft.id}"]`)
  await page.waitForSelector('[data-sw-send-agent-menu]')
  await shot(page, 'board-send-menu-1440-dark')
  await page.keyboard.press('Escape')
  assert.deepEqual(errors, [])
})

test('a phone: the More menu opens an Agents sheet, and a thread sends its comment to an agent', async () => {
  const mine = await unsent(ada, 'From a phone', 80)
  const { page, errors } = await open(ada, { width: 390, height: 844, phone: true })
  await page.goto(boardPage())
  await page.waitForSelector('[data-sw-menu]')
  await page.tap('[data-sw-menu]')
  await page.waitForSelector('[data-sw-hosted-agent-open]')
  assert.match(await page.textContent('[data-sw-hosted-agent-open]'), /Agents\s*2 of 2 online/)
  await page.tap('[data-sw-hosted-agent-open]')
  await page.waitForSelector('[data-sw-hosted-agent-sheet] [data-sw-hosted-agent-row]')
  assert.equal(new URL(page.url()).searchParams.get('ha'), '1')
  assert.equal(await page.locator('[data-sw-hosted-agent-sheet] [data-sw-hosted-agent-row]').count(), 2)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('[data-sw-hosted-agent-sheet] button, [data-sw-hosted-agent-sheet] a[href]')]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 44)
      .map((el) => el.textContent.trim().slice(0, 30)),
  )
  assert.deepEqual(small, [], 'touch targets under 44 px')
  await shot(page, 'board-panel-390-light')

  // The thread, as a sheet: the same split control, by touch.
  await page.goto(boardPage(`&c=${mine.id}`))
  await page.waitForSelector(`[data-sw-thread-sheet="${mine.id}"] [data-sw-send-agent="${mine.id}"]`)
  await shot(page, 'board-send-390-light')
  await page.tap(`[data-sw-send-agent-choose="${mine.id}"]`)
  await page.waitForSelector('[data-sw-send-agent-menu]')
  await shot(page, 'board-send-menu-390-light')
  await page.tap('[data-sw-send-agent-option="any"]')
  await until(() => ran().some((line) => line.endsWith(`#${mine.id}`)), 'an agent to take it')
  assert.equal(ran().filter((line) => line.endsWith(`#${mine.id}`)).length, 1, 'taken once')
  assert.deepEqual(errors, [])

  const dark = await open(ada, { width: 390, height: 844, phone: true, dark: true })
  await dark.page.goto(boardPage('&ha=1'))
  await dark.page.waitForSelector('[data-sw-hosted-agent-sheet] [data-sw-hosted-agent-row]')
  await shot(dark.page, 'board-panel-390-dark')
  assert.deepEqual(dark.errors, [])
})

test("a phone: the console's Agents page fits, with touch targets", async () => {
  const { page, errors } = await open(ada, { width: 390, height: 844, phone: true })
  await page.goto(`${hosted.origin}/w/${ws}/agents/${project.id}`)
  await page.waitForSelector('[data-sw-agent-row="Scout"]')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('main button, main a[href]')]
      .filter((el) => el.offsetParent !== null && !el.closest('p'))
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => el.textContent.trim().slice(0, 30)),
  )
  assert.deepEqual(small, [], 'touch targets under 44 px')
  await shot(page, 'console-agents-390-light')
  await page.goto(`${hosted.origin}/w/${ws}/agents`)
  await page.waitForSelector('[data-sw-overview-agent="Builder"]')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll')
  await shot(page, 'console-overview-390-light')
  assert.deepEqual(errors, [])
})
