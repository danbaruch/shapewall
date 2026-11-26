// The starter agent on the capability model (plan 3.3, Q4): the gate's trust
// read as a tier, named commands from the checkout's config (build, dev,
// lint, ...) with the re-ask rule, the dev server in the background, the
// throwaway browser limited to the egress allowlist plus that dev server,
// and the capability block at the end of the prompt.
//
// The browser is a stand-in chromium that sends each page load through the
// agent browser's own route check and egress proxy (as test/dev-server.test.js
// does), so what the allowlist lets through really reaches the server. Real
// Chromium inside the container is not run here (test/starter-agent-container.test.js
// is the opt-in container test).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { loadConfig } from '../src/config.js'
import { createAgentBrowser } from '../src/agent/agent-browser.js'
import { toPrompt } from '../src/agent/capability-render.js'
import { gateComment } from '../src/agent/starter/gate.js'
import { starterSystemPrompt } from '../src/agent/starter/prompt.js'
import { runSandbox } from '../src/agent/starter/sandbox-main.js'
import { starterSettings } from '../src/agent/starter/settings.js'
import { localSource } from '../src/agent/starter/source.js'
import { egressAllowList, runStarter, starterCapabilities, starterMachine, starterTrust } from '../src/agent/starter/supervisor.js'
import { createTools } from '../src/agent/starter/tools.js'
import { resolveCapabilities } from '../src/agent/capabilities.js'
import { createComment, getComment } from '../src/store.js'
import { tempDir } from './helpers.js'
import { startStarterStub } from './fixtures/starter-model-stub.mjs'

const posix = { skip: process.platform === 'win32' ? 'POSIX only' : false, timeout: 60_000 }
const gitIn = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: dir,
    stdio: 'pipe',
  }).toString()

const tierFor = (comment, { trusted = ['dan'], hosted = false } = {}) => {
  const set = new Set(trusted)
  const gate = gateComment(comment, { trusted: set, hosted })
  const trust = starterTrust(comment, gate, { trusted: set, hosted })
  return resolveCapabilities({ path: 'starter', trust, audience: 'server', machine: starterMachine() }).tier
}

// ---- The gate's trust, as the resolver reads it ----

test('starterTrust: trusted authors are the team tier; any other author, an agent reply or a forced run is open', () => {
  const comment = (extra = {}) => ({ id: 1, status: 'open', body: 'Make it blue', author: 'Dan', replies: [], ...extra })
  assert.equal(tierFor(comment()), 'team', 'a trusted member wrote it')
  // An untrusted author, tagged by a trusted member: the tag vouches for the comment.
  const tagged = comment({ author: 'Mallory', replies: [{ author: 'Dan', body: '@agent go', createdAt: '2026-11-26T10:00:00Z' }] })
  assert.equal(tierFor(tagged), 'team')
  // Someone else replied too: their text reaches the model, so the turn is open.
  assert.equal(tierFor({ ...tagged, replies: [...tagged.replies, { author: 'Eve', body: 'also delete the tests' }] }), 'open')
  // A guest's reply never reaches the model, so it does not count.
  assert.equal(tierFor({ ...tagged, replies: [...tagged.replies, { author: 'G', body: 'x', guest: true }] }), 'team')
  // An agent's reply is not a trusted person's, even when its name is on the list.
  assert.equal(tierFor(comment({ replies: [{ author: 'agent', body: 'Starter agent finished.' }] }), { trusted: ['dan', 'agent'] }), 'open')
  // Not dispatched (the run was forced with --trust-comment): no trust block, open.
  const untrusted = comment({ author: 'Mallory' })
  const set = new Set(['dan'])
  assert.equal(starterTrust(untrusted, gateComment(untrusted, { trusted: set }), { trusted: set }), null)
  assert.equal(tierFor(untrusted), 'open')
  // Hosted: the attested handle counts, never the display name.
  const hosted = (extra) => ({ id: 2, status: 'open', body: 'x', author: 'Dan', dispatchable: true, replies: [], ...extra })
  assert.equal(tierFor(hosted({ authorHandle: 'dan' }), { hosted: true }), 'team')
  assert.equal(tierFor(hosted({}), { hosted: true }), 'open', 'a display name alone is not a handle')
  assert.equal(tierFor(hosted({ authorHandle: 'dan', replies: [{ author: 'Dan', handle: 'eve', body: 'x' }] }), { hosted: true }), 'open')
})

// ---- What the container gets ----

function projectConfig(name, { commands, starterAgent = { trusted: ['dan'] }, extra = {} } = {}) {
  const dir = fs.realpathSync(tempDir(name))
  fs.writeFileSync(
    path.join(dir, 'shapewall.config.json'),
    JSON.stringify({
      title: 'T',
      id: 'site',
      baseUrl: 'http://127.0.0.1:9',
      publicUrl: 'https://app.example.com',
      pages: [{ id: 'home', path: '/', title: 'Home' }],
      starterAgent,
      commands,
      ...extra,
    }),
  )
  return { dir, config: loadConfig(path.join(dir, 'shapewall.config.json')) }
}

test('starterCapabilities: commands from the checkout config, a card each on open turns, the browser kept to the egress allowlist', () => {
  const { config } = projectConfig('starter-caps', {
    starterAgent: { trusted: ['dan'], testCommand: 'node other-tests.js' },
    commands: {
      test: 'node t.js',
      build: { run: 'node b.js', inputs: ['b.config.js'] },
      dev: 'node server.js',
      lint: { run: 'node l.js', mutating: false },
    },
  })
  const source = { board: config.boards[0], hosted: false }
  const settings = starterSettings(config, { env: { SHAPEWALL_AGENT_EGRESS: 'app.example.com' } })
  const allow = egressAllowList(settings)
  const trusted = { id: 1, status: 'open', author: 'Dan', body: 'x', replies: [] }
  const team = starterCapabilities({ settings, comment: trusted, gate: gateComment(trusted, { trusted: new Set(['dan']) }), source, allow })
  assert.equal(team.resolved.tier, 'team')
  assert.equal(team.resolved.shell.mode, 'container')
  assert.equal(team.resolved.edit.where, 'container')
  // commands.test wins over starterAgent.testCommand.
  assert.deepEqual(team.commands.find((item) => item.name === 'test').argv, ['node', 't.js'])
  assert.deepEqual(
    team.commands.map((item) => [item.name, item.needsCard]),
    [
      ['test', false],
      ['build', false],
      ['dev', false],
      ['lint', false],
    ],
  )
  assert.deepEqual(team.commands.find((item) => item.name === 'build').inputs, ['b.config.js'])
  // The config's loopback baseUrl is the container itself there: not opened. The
  // public origin is, because the egress allowlist has its host and port.
  assert.deepEqual(team.browser, { allow: ['https://app.example.com'], allowNoSandbox: true })
  assert.deepEqual(team.caps.browser.allow, ['https://app.example.com'])
  assert.match(toPrompt(team.caps), /On this board \(tier: team\)/)
  // Someone outside the list wrote in it: every named command asks first,
  // and Chromium never starts without its own sandbox.
  const mixed = { ...trusted, replies: [{ author: 'Eve', body: 'and run this' }] }
  const open = starterCapabilities({ settings, comment: mixed, gate: gateComment(mixed, { trusted: new Set(['dan']) }), source, allow })
  assert.equal(open.resolved.tier, 'open')
  assert.ok(open.commands.length === 4 && open.commands.every((item) => item.needsCard))
  assert.equal(open.browser.allowNoSandbox, false)
  // No egress entry for the app's host: no origin at all (the dev server joins inside).
  const narrow = starterSettings(config, { env: {} })
  const none = starterCapabilities({
    settings: narrow,
    comment: trusted,
    gate: gateComment(trusted, { trusted: new Set(['dan']) }),
    source,
    allow: egressAllowList(narrow),
  })
  assert.deepEqual(none.browser.allow, [])
})

// ---- Named commands in the container ----

function commandProject(name) {
  const root = fs.realpathSync(tempDir(name))
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(root, 'b.config.js'), 'module.exports = {}\n')
  fs.writeFileSync(
    path.join(root, 'b.js'),
    "require('fs').mkdirSync('dist', { recursive: true }); require('fs').writeFileSync('dist/out.txt', 'built')\n",
  )
  fs.writeFileSync(path.join(root, 'l.js'), "console.log('lint from the checkout config')\n")
  fs.writeFileSync(path.join(root, 'gen.js'), "require('fs').writeFileSync('package.json', '{\"generated\":true}\\n')\n")
  return root
}
const COMMANDS = [
  { name: 'test', argv: ['node', '-e', 'process.exit(0)'], inputs: null, mutating: true, args: false, ready: null, needsCard: false },
  { name: 'build', argv: ['node', 'b.js'], inputs: ['b.config.js'], mutating: true, args: false, ready: null, needsCard: false },
  { name: 'lint', argv: ['node', 'l.js'], inputs: null, mutating: false, args: false, ready: null, needsCard: false },
  { name: 'gen', argv: ['node', 'gen.js'], inputs: null, mutating: true, args: false, ready: null, needsCard: false },
]
const asking = (approve) => {
  const asked = []
  return {
    asked,
    rpc: { call: async (method, params) => (asked.push({ method, params }), method === 'approve' ? { approved: approve } : { ok: true }) },
  }
}

test('run_named_command: only the names the host sent, and their lines, never the worktree config', posix, async () => {
  const root = commandProject('starter-named')
  // The agent can write this file: its commands must never be used.
  fs.writeFileSync(
    path.join(root, 'shapewall.config.json'),
    JSON.stringify({ commands: { deploy: 'touch pwned', lint: "node -e \"require('fs').writeFileSync('pwned','')\"" } }),
  )
  const { asked, rpc } = asking(true)
  const tools = createTools({ root, rpc, commands: COMMANDS, shell: true, remainingMs: () => 60000 })
  assert.ok(tools.names.includes('run_tests') && tools.names.includes('run_named_command'))
  assert.ok(!tools.names.includes('stop_dev_server'), 'no dev command, no stop_dev_server')
  const spec = tools.specs.find((item) => item.name === 'run_named_command')
  assert.deepEqual(spec.parameters.properties.name.enum, ['build', 'lint', 'gen'])
  const lint = await tools.run({ name: 'run_named_command', args: { name: 'lint' } })
  assert.equal(lint.ok, true, lint.text)
  assert.match(lint.text, /lint from the checkout config/)
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false, "the worktree's line for lint never ran")
  const deploy = await tools.run({ name: 'run_named_command', args: { name: 'deploy' } })
  assert.equal(deploy.ok, false)
  assert.match(deploy.text, /"deploy" is not a command you can run here\. You can run: test \(run_tests\), build, lint, gen/)
  const args = await tools.run({ name: 'run_named_command', args: { name: 'lint', args: ['--fix'] } })
  assert.equal(args.ok, false)
  assert.match(args.text, /takes no arguments/)
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false)
  assert.equal(asked.length, 0, 'nothing asked: the inputs are as the run started')
})

test('the re-ask rule: a changed input, a file a command changed, a shell command, an open turn', posix, async () => {
  const root = commandProject('starter-reask')
  // A changed input of build (its `inputs`): asked, and denied means not run.
  let { asked, rpc } = asking(false)
  let tools = createTools({ root, rpc, commands: COMMANDS, shell: true, remainingMs: () => 60000 })
  await tools.run({ name: 'write_file', args: { path: 'b.config.js', content: 'module.exports = { evil: true }\n' } })
  let result = await tools.run({ name: 'run_named_command', args: { name: 'build' } })
  assert.equal(result.ok, false)
  assert.match(result.text, /Not run/)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].params.command, 'node b.js')
  assert.match(asked[0].params.reason, /changed b\.config\.js, which decides what the "build" command runs/)
  assert.equal(fs.existsSync(path.join(root, 'dist', 'out.txt')), false, 'not run')
  // lint does not depend on b.config.js: runs without asking.
  assert.equal((await tools.run({ name: 'run_named_command', args: { name: 'lint' } })).ok, true)
  assert.equal(asked.length, 1)
  // Approved: runs.
  ;({ asked, rpc } = asking(true))
  tools = createTools({ root, rpc, commands: COMMANDS, shell: true, remainingMs: () => 60000 })
  await tools.run({ name: 'edit_file', args: { path: 'b.config.js', oldText: 'evil', newText: 'fine' } })
  result = await tools.run({ name: 'run_named_command', args: { name: 'build' } })
  assert.equal(result.ok, true, result.text)
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'out.txt'), 'utf8'), 'built')
  // A named command that changed a file others depend on (package.json): the next run of another asks.
  ;({ asked, rpc } = asking(false))
  tools = createTools({ root, rpc, commands: COMMANDS, shell: true, remainingMs: () => 60000 })
  assert.equal((await tools.run({ name: 'run_named_command', args: { name: 'gen' } })).ok, true)
  result = await tools.run({ name: 'run_named_command', args: { name: 'lint' } })
  assert.equal(result.ok, false)
  assert.match(asked.at(-1).params.reason, /A file the "lint" command depends on changed since the run started/)
  // The same for run_tests, and with no approvals in the run it is not run at all.
  const off = createTools({ root, rpc, commands: COMMANDS, shell: false, remainingMs: () => 60000 })
  assert.equal((await off.run({ name: 'run_named_command', args: { name: 'gen' } })).ok, true)
  fs.writeFileSync(path.join(root, 'package.json'), '{"changed":1}\n')
  result = await off.run({ name: 'run_tests', args: {} })
  assert.equal(result.ok, false)
  assert.match(result.text, /needs a person's approval, which this run does not have/)
  // An approved shell command ran: every named command asks after it.
  ;({ asked, rpc } = asking(true))
  tools = createTools({ root, rpc, commands: COMMANDS, shell: true, remainingMs: () => 60000 })
  assert.equal((await tools.run({ name: 'run_shell', args: { command: 'true', reason: 'check' } })).ok, true)
  assert.equal((await tools.run({ name: 'run_named_command', args: { name: 'lint' } })).ok, true)
  assert.match(asked.at(-1).params.reason, /An approved command ran earlier in this run/)
  // An open turn: every run asks, unchanged inputs or not.
  ;({ asked, rpc } = asking(false))
  tools = createTools({
    root,
    rpc,
    commands: COMMANDS.map((item) => ({ ...item, needsCard: true })),
    shell: true,
    remainingMs: () => 60000,
  })
  result = await tools.run({ name: 'run_named_command', args: { name: 'lint' } })
  assert.equal(result.ok, false)
  assert.match(asked.at(-1).params.reason, /Someone outside the people trusted on this board wrote in this comment/)
  assert.equal((await tools.run({ name: 'run_tests', args: {} })).ok, false)
  assert.equal(asked.length, 2)
  // A command without an explicit needsCard asks too (the narrowest reading).
  ;({ asked, rpc } = asking(false))
  tools = createTools({ root, rpc, commands: [{ name: 'lint', argv: ['node', 'l.js'] }], shell: true })
  assert.equal((await tools.run({ name: 'run_named_command', args: { name: 'lint' } })).ok, false)
  assert.equal(asked.length, 1)
})

// ---- The dev server and the browser ----

// The stand-in chromium: page.goto runs the context's route handler, then
// sends the request through the proxy the agent browser gave it.
function viaProxyChromium(seen) {
  return {
    async launchPersistentContext(dir, options) {
      const proxy = new URL(options.proxy.server)
      let routeHandler = null
      const handlers = {}
      let current = 'about:blank'
      let closed = false
      const page = {
        on() {},
        url: () => current,
        title: async () => '',
        isClosed: () => closed,
        mainFrame: () => ({}),
        async goto(url) {
          let verdict = null
          await routeHandler({
            request: () => ({ url: () => url, headers: () => ({}) }),
            continue: () => (verdict = 'continue'),
            abort: () => (verdict = 'abort'),
          })
          if (verdict !== 'continue') throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`)
          const body = await new Promise((resolve, reject) => {
            const request = http.request(
              { host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: url, headers: { host: new URL(url).host } },
              (response) => {
                let data = ''
                response.setEncoding('utf8')
                response.on('data', (chunk) => (data += chunk))
                response.on('end', () => resolve({ status: response.statusCode, data }))
              },
            )
            request.on('error', reject)
            request.end()
          })
          seen.push({ url, ...body })
          current = url
          return { status: () => body.status }
        },
      }
      return {
        addInitScript: async () => {},
        route: async (pattern, handler) => (routeHandler = handler),
        routeWebSocket: async () => {},
        on: (event, fn) => (handlers[event] = fn),
        pages: () => [],
        newPage: async () => page,
        async close() {
          closed = true
          handlers.close?.()
        },
      }
    },
  }
}

function devProject(name) {
  const root = fs.realpathSync(tempDir(name))
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
  fs.writeFileSync(
    path.join(root, 'server.js'),
    "require('http').createServer((q, r) => r.end('dev ' + process.env.PORT + ' ' + q.url)).listen(Number(process.env.PORT), '127.0.0.1')\n",
  )
  return root
}
const DEV = { name: 'dev', argv: ['node', 'server.js'], inputs: null, mutating: true, args: false, ready: null, needsCard: false }
const listen = () =>
  new Promise((resolve) => {
    const server = http.createServer((q, r) => r.end('someone else'))
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

test('dev: runs in the background on a port, and the browser opens that port only', posix, async (t) => {
  const root = devProject('starter-dev')
  const browserRoot = fs.realpathSync(tempDir('starter-dev-browser'))
  const seen = []
  const other = await listen()
  t.after(() => other.close())
  const browser = createAgentBrowser({
    browser: { on: true, allow: [], auth: null, profile: null, allowNoSandbox: false, realChrome: false },
    tmpRoot: browserRoot,
    chromium: viaProxyChromium(seen),
    warn: () => {},
  })
  const { rpc } = asking(false)
  const tools = createTools({ root, rpc, commands: [DEV], browser, shell: true, remainingMs: () => 60000 })
  t.after(() => tools.close())
  assert.ok(tools.names.includes('stop_dev_server'))
  for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'browser_text', 'browser_console', 'browser_close'])
    assert.ok(tools.names.includes(name), name)
  assert.ok(!tools.names.includes('browser_screenshot'), 'this model reads text only')
  const navigate = tools.specs.find((item) => item.name === 'browser_navigate')
  assert.equal(navigate.parameters.type, 'object')
  assert.deepEqual(navigate.parameters.required, ['url'])
  const otherUrl = `http://127.0.0.1:${other.address().port}/`
  // Nothing allowed yet: an origin on this machine is refused.
  let result = await tools.run({ name: 'browser_navigate', args: { url: otherUrl } })
  assert.equal(result.ok, false)
  assert.match(result.text, /is not on this browser's allowlist/)
  // The dev server: started, answering, given to the browser.
  result = await tools.run({ name: 'run_named_command', args: { name: 'dev' } })
  assert.equal(result.ok, true, result.text)
  const port = Number(/Your browser tools can open http:\/\/127\.0\.0\.1:(\d+)/.exec(result.text)?.[1])
  assert.ok(port > 0, result.text)
  result = await tools.run({ name: 'browser_navigate', args: { url: `http://127.0.0.1:${port}/home` } })
  assert.equal(result.ok, true, result.text)
  assert.equal(seen.at(-1).data, `dev ${port} /home`)
  assert.match(result.text, /<shapewall-data source="agent-browser"[^>]*trust="untrusted"/)
  // Another port on 127.0.0.1, a debugging port, a public origin: refused, never reached.
  for (const url of [otherUrl, 'http://127.0.0.1:9222/json', 'https://example.com/']) {
    const refused = await tools.run({ name: 'browser_navigate', args: { url } })
    assert.equal(refused.ok, false, url)
    assert.match(refused.text, /not on this browser's allowlist/, url)
  }
  assert.ok(!seen.some((item) => item.data === 'someone else'))
  // Bad arguments are refused before the browser sees them.
  assert.equal((await tools.run({ name: 'browser_navigate', args: { url: 5 } })).ok, false)
  // A second start says where the first runs.
  assert.match((await tools.run({ name: 'run_named_command', args: { name: 'dev' } })).text, /already running/)
  // Stopped: its port leaves the allowlist.
  const stopped = await tools.run({ name: 'stop_dev_server', args: {} })
  assert.match(stopped.text, new RegExp(`Stopped "dev" \\(port ${port}\\)`))
  result = await tools.run({ name: 'browser_navigate', args: { url: `http://127.0.0.1:${port}/` } })
  assert.equal(result.ok, false)
  // The end of the task: the browser is gone for good.
  await tools.close()
  assert.equal(browser.disposed, true)
  assert.equal((await tools.run({ name: 'browser_navigate', args: { url: otherUrl } })).ok, false)
})

test('dev: a changed input asks first; a server that never answers is stopped; close ends a running one', posix, async (t) => {
  const root = devProject('starter-dev-ask')
  const { asked, rpc } = asking(false)
  const tools = createTools({ root, rpc, commands: [DEV], shell: true, remainingMs: () => 60000 })
  t.after(() => tools.close())
  await tools.run({ name: 'write_file', args: { path: 'server.js', content: "require('fs').writeFileSync('pwned', '')\n" } })
  const result = await tools.run({ name: 'run_named_command', args: { name: 'dev' } })
  assert.equal(result.ok, false)
  assert.match(asked.at(-1).params.reason, /changed server\.js, which decides what the "dev" command runs/)
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false)
  // A server that exits at once: said so, nothing left running.
  const quick = createTools({
    root: devProject('starter-dev-exit'),
    rpc,
    commands: [{ ...DEV, argv: ['node', '-e', 'process.exit(3)'] }],
    shell: true,
    remainingMs: () => 60000,
  })
  const exited = await quick.run({ name: 'run_named_command', args: { name: 'dev' } })
  assert.equal(exited.ok, false)
  assert.match(exited.text, /exited \(exit 3\)/)
  // close() stops a server that is still running.
  const running = createTools({ root: devProject('starter-dev-close'), rpc, commands: [DEV], shell: true, remainingMs: () => 60000 })
  const started = await running.run({ name: 'run_named_command', args: { name: 'dev' } })
  assert.equal(started.ok, true, started.text)
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(started.text)[1])
  await running.close()
  const free = await new Promise((resolve) => {
    const server = http.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
  assert.equal(free, true, 'the port is free again')
})

// Opt-in: the same tools with real Playwright Chromium (on this machine, not
// in the container): SHAPEWALL_IT_BROWSER=1 node --test test/starter-agent-commands.test.js
test(
  'dev and the browser with real Chromium',
  { skip: process.env.SHAPEWALL_IT_BROWSER === '1' ? false : 'set SHAPEWALL_IT_BROWSER=1', timeout: 120_000 },
  async (t) => {
    const root = devProject('starter-dev-real')
    const other = await listen()
    t.after(() => other.close())
    const browser = createAgentBrowser({
      browser: { on: true, allow: [], auth: null, profile: null, allowNoSandbox: false, realChrome: false },
      tmpRoot: fs.realpathSync(tempDir('starter-dev-real-browser')),
      warn: () => {},
    })
    const tools = createTools({ root, rpc: asking(false).rpc, commands: [DEV], browser, shell: true, remainingMs: () => 60000 })
    t.after(() => tools.close())
    const started = await tools.run({ name: 'run_named_command', args: { name: 'dev' } })
    const port = Number(/Your browser tools can open http:\/\/127\.0\.0\.1:(\d+)/.exec(started.text)?.[1])
    assert.ok(port > 0, started.text)
    const opened = await tools.run({ name: 'browser_navigate', args: { url: `http://127.0.0.1:${port}/real` } })
    assert.equal(opened.ok, true, opened.text)
    const text = await tools.run({ name: 'browser_text', args: {} })
    assert.match(text.text, new RegExp(`dev ${port} /real`))
    const refused = await tools.run({ name: 'browser_navigate', args: { url: `http://127.0.0.1:${other.address().port}/` } })
    assert.equal(refused.ok, false)
    await tools.close()
    assert.equal(browser.disposed, true)
  },
)

// ---- The prompt ----

test('the prompt: the capability block comes after the instructions', () => {
  const caps = resolveCapabilities({
    path: 'starter',
    trust: { authors: [{ owner: false, member: true }], guests: false },
    audience: 'server',
    machine: starterMachine(),
  })
  const tools = ['read_file', 'run_named_command', 'stop_dev_server', 'browser_navigate']
  const system = starterSystemPrompt({ tools, capabilities: caps })
  const block = toPrompt(caps)
  assert.ok(system.endsWith(block))
  assert.ok(system.indexOf('Rules about data') < system.indexOf(block))
  assert.match(system, /start its dev server with run_named_command \(dev\)/)
  assert.ok(!system.includes('You cannot see the app rendered'))
  // Without capabilities (an older host), the instructions alone.
  assert.ok(!starterSystemPrompt({ tools: ['read_file'] }).includes('On this board'))
})

// ---- End to end: the host resolves, the container uses it ----

function fakeRuntime(browserOptions) {
  const tasks = []
  return {
    name: 'podman',
    bin: '/usr/bin/podman',
    tasks,
    async exec(args) {
      if (args[0] === 'network' && args[1] === 'inspect') return { code: 1, stdout: '', stderr: 'no such network' }
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn(args) {
      const child = new EventEmitter()
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      if (args[0] === 'start') {
        setImmediate(() => child.stdout.write(`${JSON.stringify({ ready: true })}\n`))
        return child
      }
      let first = true
      child.stdin.on('data', (chunk) => {
        if (first) tasks.push(JSON.parse(String(chunk).split('\n')[0]))
        first = false
      })
      const mount = args[args.indexOf('-v') + 1].split(':')[0]
      Promise.resolve(runSandbox({ input: child.stdin, output: child.stdout, root: mount, browserOptions }))
        .catch(() => {})
        .finally(() => {
          child.stdout.end()
          setImmediate(() => child.emit('close', 0))
        })
      return child
    },
  }
}

const stubs = []
after(async () => {
  for (const stub of stubs) await stub.close()
})

test('a run: the checkout config decides the commands, the container offers them and the browser, the prompt says so', posix, async () => {
  const script = [
    {
      tools: [
        { name: 'run_named_command', args: { name: 'lint' } },
        { name: 'run_named_command', args: { name: 'deploy' } },
      ],
    },
    { tools: [{ name: 'run_named_command', args: { name: 'dev' } }] },
    { text: 'Ran lint and looked at the app.' },
  ]
  const stub = await startStarterStub({ script })
  stubs.push(stub)
  const dir = fs.realpathSync(tempDir('starter-commands-run'))
  gitIn(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n')
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')
  fs.writeFileSync(
    path.join(dir, 'server.js'),
    "require('http').createServer((q, r) => r.end('dev')).listen(Number(process.env.PORT), '127.0.0.1')\n",
  )
  const write = (commands) =>
    fs.writeFileSync(
      path.join(dir, 'shapewall.config.json'),
      JSON.stringify({
        title: 'T',
        id: 'site',
        baseUrl: 'http://127.0.0.1:9',
        pages: [{ id: 'home', path: '/', title: 'Home' }],
        agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model' },
        starterAgent: { trusted: ['dan'], testCommand: 'node -e "process.exit(0)"' },
        commands,
      }),
    )
  // The committed config (what the worktree gets) names a lint line that
  // writes a file; the checkout's config, as the person has it now, does not.
  write({ lint: "node -e \"require('fs').writeFileSync('pwned-by-worktree-config','')\"", deploy: 'touch pwned' })
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-q', '-m', 'init')
  write({ lint: { run: 'node -e "console.log(1)"', mutating: false }, dev: 'node server.js' })
  const config = loadConfig(path.join(dir, 'shapewall.config.json'))
  const comment = await createComment(config, config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 1,
    y: 1,
    body: 'Check it',
    author: 'Dan',
  })
  const seen = []
  const runtime = fakeRuntime({ chromium: viaProxyChromium(seen), tmpRoot: fs.realpathSync(tempDir('starter-commands-browser')) })
  const result = await runStarter({
    source: localSource(config),
    settings: starterSettings(config, { env: {} }),
    runtime,
    image: 'localhost/shapewall-agent:latest',
    commentId: comment.id,
    projectDir: dir,
    outputDir: config.outputDir,
    workDir: fs.realpathSync(tempDir('starter-commands-work')),
    env: {},
    log: () => {},
  })
  assert.equal(result.failure, null, result.failure?.message)
  const task = runtime.tasks[0]
  assert.deepEqual(
    task.tools.commands.map((item) => [item.name, item.argv.join(' '), item.needsCard]),
    [
      ['lint', 'node -e console.log(1)', false],
      ['dev', 'node server.js', false],
      ['test', 'node -e process.exit(0)', false],
    ],
  )
  assert.deepEqual(task.tools.browser, { allow: [], allowNoSandbox: true })
  assert.equal(task.capabilities.tier, 'team')
  // The prompt the model got ends with the capability block.
  const system = stub.calls[0].body.messages[0].content
  assert.match(system, /On this board \(tier: team\) you can:/)
  assert.match(system, /Runs lint, dev, test/)
  // deploy (only in the committed config) was refused; lint ran the checkout's line.
  const toolText = JSON.stringify(stub.calls[1].body.messages)
  assert.match(toolText, /\\"deploy\\" is not a command you can run here/)
  assert.ok(!result.files.includes('pwned-by-worktree-config'))
  assert.ok(!result.files.includes('pwned'))
  const devText = JSON.stringify(stub.calls[2].body.messages.at(-1))
  assert.match(devText, /Your browser tools can open http:\/\/127\.0\.0\.1:\d+/)
  assert.equal(getComment(config, 'site', comment.id).agentStatus, 'needs-human')
})
