// Commands in a hosted fix, through Shapewall's own tools (exec-mcp.js), end
// to end over the real HTTP surfaces: a machine that opted in, "Fix with",
// the scripted agent calling the exec server that session/new named, and,
// on the open tier, the command card someone answers on the board.
//
// The solo half needs the OS sandbox (bubblewrap, socat and ripgrep on
// Linux; Seatbelt on macOS): skipped with a notice without it, unless
// SHAPEWALL_SANDBOX_TEST=1 (CI's sandbox jobs), where it must run.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { closeSandbox, probeSandbox } from '../src/agent/sandbox-exec.js'
import { createProject, reauth, signUp, startHostedServer } from './hosted-helpers.js'
import { connectAgent, fixScript, gitRepo, parseEvents, startLink, until } from './hosted-chat-helpers.js'
import { tempDir } from './helpers.js'

const probe = probeSandbox()
const required = process.env.SHAPEWALL_SANDBOX_TEST === '1'
if (!probe.available && !required)
  console.log('# hosted-exec: the OS sandbox does not start here (' + probe.reason + '): the solo sandbox test is skipped')
const boxed = { skip: probe.available || required ? false : 'no OS sandbox here (' + probe.reason + ')' }
const posix = { skip: process.platform === 'win32' ? 'the fixture project runs npm through a POSIX shell' : false }

let hosted
let ada
let ws
let project
const links = []

const boardUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const agentUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/agent/boards/sample${rest}`
const threadUrl = (number, rest = '') => agentUrl(`/threads/comment-${number}${rest}`)
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`

const PROJECT = {
  'index.html': '<h1>Hello</h1>\n',
  'package.json': JSON.stringify({ name: 'exec-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }) + '\n',
  'test/ok.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('adds', () => assert.equal(1 + 1, 2))\n",
}
const COMMANDS = { test: { name: 'test', run: 'npm test', argv: ['npm', 'test'], inputs: null, mutating: true, args: false, ready: null } }
// The machine's own rules for commands: the defaults `agent connect` writes.
const COMMAND_POLICY = { shell: 'sandboxed', commandApproval: 'tier', shellNetwork: 'registries' }

async function agentWith(name, { audience, policy, link = {} }) {
  const made = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name, kind: 'claude', audience })
  assert.equal(made.status, 200, JSON.stringify(made.error))
  const dir = tempDir('hosted-exec-' + name.toLowerCase())
  const git = gitRepo(dir, PROJECT)
  const entry = startLink(hosted, made.token, {
    cwd: dir,
    edits: { ...COMMAND_POLICY, ...policy },
    fixConfig: { commands: COMMANDS },
    ...link,
  })
  links.push(entry)
  assert.ok(await entry.ready, entry.failure()?.message)
  return { ...made, dir, git, link: entry }
}
const comment = async (body) => {
  hosted.rateLimiter.reset()
  const made = await ada.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 30, y: 30, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
function pressFix(number, agent) {
  hosted.rateLimiter.reset()
  return ada.browser.post(threadUrl(number, '/messages'), { fix: true, agentId: agent.agentId }).then((response) => {
    const events = response.status === 200 ? parseEvents(response.text) : []
    return { status: response.status, events, final: events.find((event) => event.name === 'done')?.data.message || null }
  })
}
const cards = async () => (await ada.browser.get(agentUrl('/permissions'))).json.permissions

before(async () => {
  hosted = await startHostedServer('hosted-exec')
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  project = await createProject(ada, ws, 'Site')
  // A board for the comments (no captures needed).
  hosted.rateLimiter.reset()
  await reauth(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  assert.equal(made.status, 201, made.text)
  const { createRemote, pushDefinition, pushFiles } = await import('../src/remote/remote.js')
  const { sampleConfig } = await import('./helpers.js')
  const { writeLocalCaptures } = await import('./hosted-helpers.js')
  const config = sampleConfig('hosted-exec-board')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
})

after(async () => {
  for (const entry of links) await entry.stop()
  await hosted?.close()
  await closeSandbox()
})

test('solo: a hosted Fix runs npm test in the OS sandbox, with no card; ~/x and other hosts stay out of reach', boxed, async () => {
  const agent = await agentWith('Solo', { audience: 'owner', policy: { audience: 'owner', approvals: 'owner' } })
  const homeX = path.join(os.homedir(), 'x')
  const hadX = fs.existsSync(homeX)
  const probeFile = path.join(os.homedir(), '.sw-exec-probe-' + randomBytes(6).toString('hex'))
  const made = await comment(
    'Run the tests ' +
      fixScript([
        ['mcp', 'run_named_command', { name: 'test' }],
        [
          'mcp',
          'run_command',
          { command: 'echo escaped > ' + (hadX ? probeFile : homeX) + '; echo escaped > ' + probeFile, reason: 'try' },
        ],
        [
          'mcp',
          'run_command',
          { command: "curl -sS -o /dev/null -m 15 -w 'status %{http_code}' --fail https://example.com/", reason: 'try' },
        ],
      ]),
  )
  const { final } = await pressFix(made.id, agent)
  assert.equal(final.status, 'done', JSON.stringify(final.error))
  assert.match(final.text, /mcp run_named_command ok: test: exit code 0/)
  assert.match(final.text, /pass 1/)
  assert.equal(fs.existsSync(probeFile), false, 'nothing was written in the home folder')
  if (!hadX) assert.equal(fs.existsSync(homeX), false, '~/x does not exist on the host')
  assert.match(final.text, /mcp run_command error: command: exit code [1-9]/)
  assert.equal(final.cards.filter((item) => item.name === 'command').length, 0, 'no command card on a solo turn')
  assert.equal(agent.git('status', '--porcelain'), '')
})

test('open tier: the same command waits for a card; the answer is taken and the command runs', posix, async () => {
  const agent = await agentWith('Open', { audience: 'trusted', policy: { audience: 'server', approvals: 'admins' } })
  const made = await comment('Run the tests ' + fixScript([['mcp', 'run_named_command', { name: 'test' }]]))
  const turn = pressFix(made.id, agent)
  const asked = await until(async () => (await cards()).find((item) => item.thread === 'comment-' + made.id), 'a command card')
  assert.equal(asked.name, 'command')
  assert.equal(asked.label, 'Run test')
  assert.match(asked.detail, /^npm test/)
  assert.match(asked.detail, /someone outside the people this machine trusts/)
  hosted.rateLimiter.reset()
  await reauth(ada)
  const allowed = await ada.browser.post(threadUrl(made.id, '/permissions/' + asked.id), { optionId: 'allow', hash: asked.hash })
  assert.equal(allowed.status, 200, allowed.text)
  const { final } = await turn
  assert.equal(final.status, 'done', JSON.stringify(final.error))
  assert.match(final.text, /mcp run_named_command ok: test: exit code 0/)
  assert.equal(final.cards.find((item) => item.id === asked.id)?.state, 'approved')
})

test('"the owner" is this machine\'s: a server that names another account does not make a turn solo', posix, async () => {
  // The machine saved another handle when it was approved: the server's "owner: true" for ada does not count.
  // The machine takes the server's audience (with its own "owner" it would
  // refuse the turn outright: the asker is not the account it pinned, Q7 F4).
  const agent = await agentWith('Pinned', {
    audience: 'owner',
    policy: { audience: 'server', approvals: 'owner' },
    link: { owner: 'someone-else' },
  })
  const made = await comment('Run the tests ' + fixScript([['mcp', 'run_named_command', { name: 'test' }]]))
  const turn = pressFix(made.id, agent)
  const asked = await until(async () => (await cards()).find((item) => item.thread === 'comment-' + made.id), 'a command card')
  assert.equal(asked.name, 'command')
  hosted.rateLimiter.reset()
  await reauth(ada)
  assert.equal((await ada.browser.post(threadUrl(made.id, '/permissions/' + asked.id), { optionId: 'deny', hash: asked.hash })).status, 200)
  const { final } = await turn
  assert.match(final.text, /mcp run_named_command error: Not run: it was denied on the board/)
})

// Review fix 9: the server's by.owner alone is not enough. The answer names
// who answered, and it must be the owner this machine pinned.
test('"owner" approvals: an allow from anyone but the pinned owner is not taken, even when the server says owner', posix, async () => {
  // The machine takes the server's audience (with its own "owner" it would
  // refuse the turn outright: the asker is not the account it pinned, Q7 F4).
  const agent = await agentWith('PinnedAllow', {
    audience: 'owner',
    policy: { audience: 'server', approvals: 'owner' },
    link: { owner: 'someone-else' },
  })
  const made = await comment('Run the tests ' + fixScript([['mcp', 'run_named_command', { name: 'test' }]]))
  const turn = pressFix(made.id, agent)
  const asked = await until(async () => (await cards()).find((item) => item.thread === 'comment-' + made.id), 'a command card')
  hosted.rateLimiter.reset()
  await reauth(ada)
  // ada connected the agent, so the server says by.owner; this machine pinned someone-else.
  assert.equal(
    (await ada.browser.post(threadUrl(made.id, '/permissions/' + asked.id), { optionId: 'allow', hash: asked.hash })).status,
    200,
  )
  const { final } = await turn
  assert.match(final.text, /mcp run_named_command error: Not run: it was denied on the board/)
})

test('the first owner the server names is pinned and handed back to be saved', posix, async () => {
  const pinned = []
  const agent = await agentWith('FirstOwner', {
    audience: 'owner',
    policy: { audience: 'owner', approvals: 'owner' },
    link: { onOwner: (handle) => pinned.push(handle) },
  })
  assert.deepEqual(pinned, ['ada'])
  // And the pinned owner's own allow is taken.
  const made = await comment('Run the tests ' + fixScript([['mcp', 'run_named_command', { name: 'test' }]]))
  const turn = pressFix(made.id, agent)
  const asked = await until(async () => (await cards()).find((item) => item.thread === 'comment-' + made.id), 'a command card', 2000).catch(
    () => null,
  )
  if (asked) {
    hosted.rateLimiter.reset()
    await reauth(ada)
    await ada.browser.post(threadUrl(made.id, '/permissions/' + asked.id), { optionId: 'allow', hash: asked.hash })
  }
  const { final } = await turn
  assert.match(final.text, /mcp run_named_command ok: test: exit code 0/)
})
