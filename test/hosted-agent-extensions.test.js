// Extensions on a connected agent's turns (src/remote/agent-link.js), end to
// end through a real hosted server and the stub agent named as Claude Code:
// the owner's own chat gets the agent config folder's skills and servers; a
// shared thread another member wrote in (an open turn on a machine with no
// team), a thread moved between agents and a link without a folder never do.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, invite, reauth, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { chat as send, connectAgent, startLink } from './hosted-chat-helpers.js'
import { policyExtensions } from '../src/agent/agent-config-folder.js'
import { sampleConfig, tempDir } from './helpers.js'

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-stub.mjs')
let hosted
let ada
let cyd
let ws
let project
let builder
let scout
const links = []

const chatUrl = (thread, rest = '') => `/w/${ws}/p/${project.id}/api/agent/boards/sample/threads/${thread}${rest}`
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const newChat = () => `chat-${Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16)}`
const chat = (user, url, body) => {
  hosted.rateLimiter.reset()
  return send(user, url, body)
}
function privateDir(name) {
  const dir = tempDir(name)
  fs.chmodSync(dir, 0o700)
  return dir
}
const params = async (user, thread) => {
  const answer = await chat(user, chatUrl(thread, '/messages'), 'newparams')
  assert.equal(answer.status, 200, answer.text)
  return JSON.parse(answer.final.text)
}
const hasExtensions = (sent) =>
  Boolean(sent._meta?.claudeCode?.options?.plugins?.length) && (sent.mcpServers || []).some((server) => server.name === 'brain')

before(async () => {
  hosted = await startHostedServer('hosted-agent-extensions', { signup: 'open' })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  await reauth(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  const config = sampleConfig('hosted-agent-extensions')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
  await reauth(ada)
  await ada.browser.call('PUT', consoleUrl('/agent'), {
    body: { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false },
  })
  builder = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Builder', audience: 'trusted' })
  scout = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name: 'Scout', audience: 'trusted' })

  // Builder's machine names an agent config folder with a skill and a server.
  const home = privateDir('hosted-ext-home')
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') }
  const folder = privateDir('hosted-ext-folder')
  fs.mkdirSync(path.join(folder, 'skills', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'skills', 'notes', 'SKILL.md'), '---\ndescription: Notes\n---\n')
  fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ mcpServers: { brain: { command: '/usr/bin/brain-mcp' } } }))
  const extensions = policyExtensions(folder, { env })
  assert.deepEqual(extensions.names, { skills: ['notes'], servers: ['brain'] })
  const bin = privateDir('hosted-ext-bin')
  const acp = path.join(bin, 'claude-agent-acp')
  fs.writeFileSync(acp, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" --ro-modes "$@"\n`, { mode: 0o755 })
  // Solo turns need the machine to keep the agent to its owner (audience "owner").
  const policy = { audience: 'owner', agentConfig: folder, extensionsFor: ['owner'], allowTool: ['mcp__brain__search'] }
  links.push(startLink(hosted, builder.token, { policy, extensions, acpArgv: [acp], env, owner: 'ada' }))
  // Scout's machine names none.
  links.push(startLink(hosted, scout.token, { policy: { audience: 'owner' }, acpArgv: [acp], env, owner: 'ada' }))
  for (const link of links) assert.ok(await link.ready)
})

after(async () => {
  for (const link of links) await link.stop()
  await hosted?.close()
})

test("a connected agent's owner, in a chat of their own, gets the folder's extensions; another member's words, a move and no folder never do", async () => {
  // Ada's own chat with Builder: solo, a clean thread.
  const mine = newChat()
  await reauth(ada)
  assert.equal((await ada.browser.post(chatUrl(mine, '/profile'), { profileId: builder.agentId })).status, 200)
  const sent = await params(ada, mine)
  assert.ok(hasExtensions(sent), JSON.stringify(sent._meta?.claudeCode?.options))
  assert.deepEqual(sent._meta.claudeCode.options.skills, ['notes'])
  const allowed = await chat(ada, chatUrl(mine, '/messages'), 'extcall mcp__brain__search')
  assert.match(allowed.final.text, /extcall mcp__brain__search: allow/)
  const refused = await chat(ada, chatUrl(mine, '/messages'), 'extcall mcp__brain__drop')
  assert.match(refused.final.text, /extcall mcp__brain__drop: reject/)

  // A comment thread Cyd wrote in: an open turn on a machine with no team. Never.
  const made = await ada.browser.post(`/w/${ws}/p/${project.id}/api/boards/sample/comments`, {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body: 'Shared',
  })
  assert.equal(made.status, 201, made.text)
  const thread = `comment-${made.json.comment.id}`
  assert.equal((await ada.browser.post(chatUrl(thread, '/profile'), { profileId: builder.agentId })).status, 200)
  hosted.rateLimiter.reset()
  await reauth(cyd)
  assert.equal((await chat(cyd, chatUrl(thread, '/messages'), { text: 'my words here' })).status, 200)
  assert.ok(!hasExtensions(await params(ada, thread)))

  // A chat moved to Scout and back: tainted, never again.
  const moved = newChat()
  assert.equal((await ada.browser.post(chatUrl(moved, '/profile'), { profileId: builder.agentId })).status, 200)
  assert.ok(hasExtensions(await params(ada, moved)))
  assert.equal((await ada.browser.post(chatUrl(moved, '/profile'), { profileId: scout.agentId })).status, 200)
  assert.ok(!hasExtensions(await params(ada, moved)), "Scout's machine names no folder")
  assert.equal((await ada.browser.post(chatUrl(moved, '/profile'), { profileId: builder.agentId })).status, 200)
  assert.ok(!hasExtensions(await params(ada, moved)))
})
