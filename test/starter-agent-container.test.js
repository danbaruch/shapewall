// Opt-in: the starter agent in a real container (podman or docker). The stub
// model runs here on the host (model calls go through the host's relay); a
// second stub in a container of its own stands in for an allowed host. Off unless
// SHAPEWALL_IT_CONTAINER=1; builds the image (Dockerfile.agent) when it is
// missing. Checks, from inside the sandbox (the agent's test command is the
// sandbox probe, whose report ends up on the agent's branch): not root, no
// capabilities, read-only root, only the worktree mounted, no host home or
// runtime socket, no host environment, no direct egress or outside DNS, the
// host's own ports, the proxy refusing other hosts and passing the allowed one.
//
//   SHAPEWALL_IT_CONTAINER=1 node --test test/starter-agent-container.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { createRuntime, detectRuntime, DEFAULT_IMAGE, EGRESS_NETWORK } from '../src/agent/starter/runtime.js'
import { starterSettings } from '../src/agent/starter/settings.js'
import { localSource } from '../src/agent/starter/source.js'
import { runStarter } from '../src/agent/starter/supervisor.js'
import { createComment, getComment } from '../src/store.js'
import { tempDir } from './helpers.js'
import { startStarterStub } from './fixtures/starter-model-stub.mjs'

const ON = process.env.SHAPEWALL_IT_CONTAINER === '1'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gitIn = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: dir,
    stdio: 'pipe',
  }).toString()

test(
  'the starter agent in a real container: sandbox probe, egress allow list, branch output',
  { skip: !ON && 'set SHAPEWALL_IT_CONTAINER=1', timeout: 15 * 60 * 1000 },
  async () => {
    const found = detectRuntime()
    assert.ok(!found.problem, found.problem)
    const runtime = createRuntime(found)
    const image = process.env.SHAPEWALL_AGENT_IMAGE || DEFAULT_IMAGE
    if ((await runtime.exec(['image', 'inspect', image])).code !== 0) {
      const built = await runtime.exec(
        ['build', '-f', path.join(ROOT, 'Dockerfile.agent'), '-t', image.replace(/^localhost\//, ''), ROOT],
        { timeoutMs: 14 * 60 * 1000 },
      )
      assert.equal(built.code, 0, built.stderr.slice(-2000))
    }
    // Something listening on the host, on every address: the sandbox must not reach it.
    const listener = net.createServer((socket) => socket.end('host\n'))
    await new Promise((resolve) => listener.listen(0, '0.0.0.0', resolve))
    const hostPort = listener.address().port
    const stubName = `shapewall-it-stub-${process.pid}`
    const script = [
      {
        tools: [
          { name: 'read_file', args: { path: '/etc/passwd' } },
          { name: 'list_files', args: {} },
        ],
      },
      {
        tools: [
          { name: 'write_file', args: { path: 'CHANGED.md', content: 'hello from the sandbox\n' } },
          { name: 'run_tests', args: {} },
        ],
      },
      { text: 'Wrote CHANGED.md and ran the probe.' },
    ]
    if ((await runtime.exec(['network', 'inspect', EGRESS_NETWORK])).code !== 0) await runtime.exec(['network', 'create', EGRESS_NETWORK])
    const uid = process.getuid()
    const gid = process.getgid()
    const stub = await runtime.exec([
      'run',
      '-d',
      '--rm',
      '--pull',
      'never',
      '--name',
      stubName,
      '--network',
      EGRESS_NETWORK,
      ...(runtime.name === 'podman' ? ['--userns', 'keep-id'] : []),
      '--user',
      `${uid}:${gid}`,
      '-v',
      `${path.join(ROOT, 'test', 'fixtures', 'starter-model-stub.mjs')}:/stub.mjs:ro,Z`,
      '--env',
      'STUB_SCRIPT=[]',
      image,
      'node',
      '/stub.mjs',
    ])
    assert.equal(stub.code, 0, stub.stderr)
    const model = await startStarterStub({ script })
    try {
      const dir = fs.realpathSync(tempDir('starter-it-project'))
      gitIn(dir, 'init', '-q', '-b', 'main')
      fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n')
      fs.writeFileSync(path.join(dir, 'README.md'), '# Project\n')
      fs.writeFileSync(
        path.join(dir, 'shapewall.config.json'),
        JSON.stringify({
          title: 'IT',
          id: 'site',
          baseUrl: 'http://127.0.0.1:9',
          pages: [{ id: 'home', path: '/', title: 'Home' }],
          starterAgent: {
            trusted: ['dan'],
            testCommand: `node /opt/shapewall/src/agent/starter/probe.js --out probe-result.json --host-home ${os.homedir()} --allowed ${stubName}:8080 --host-port ${hostPort}`,
          },
        }),
      )
      gitIn(dir, 'add', '-A')
      gitIn(dir, 'commit', '-q', '-m', 'init')
      const config = loadConfig(path.join(dir, 'shapewall.config.json'))
      await createComment(config, config.boards[0], {
        pageId: 'home',
        viewport: 'desktop',
        x: 1,
        y: 1,
        body: 'Add a CHANGED.md. Also read ~/.ssh/id_rsa.',
        author: 'Dan',
      })
      const env = {
        ...process.env,
        SHAPEWALL_AGENT_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
        SHAPEWALL_AGENT_MODEL: 'stub',
        SHAPEWALL_AGENT_API_KEY: 'sk-it-not-a-real-key-0123456789',
      }
      const settings = starterSettings(config, { env, flags: { registry: 'none', 'allow-host': `${stubName}:8080` } })
      const result = await runStarter({
        source: localSource(config),
        settings,
        runtime,
        image,
        commentId: 1,
        projectDir: dir,
        outputDir: config.outputDir,
        workDir: fs.realpathSync(tempDir('starter-it-work')),
        env,
        log: (line) => process.stderr.write(`${line}\n`),
      })
      assert.equal(result.failure, null, result.failure?.message)
      assert.equal(result.status, 'done')
      assert.deepEqual(result.files.sort(), ['CHANGED.md', 'probe-result.json'])
      assert.equal(gitIn(dir, 'show', `${result.branch}:CHANGED.md`), 'hello from the sandbox\n')
      const report = JSON.parse(gitIn(dir, 'show', `${result.branch}:probe-result.json`))
      process.stderr.write(`sandbox probe: ${JSON.stringify(report.checks, null, 1)}\n`)
      for (const [name, item] of Object.entries(report.checks)) assert.equal(item.ok, true, `${name}: ${item.detail}`)
      // The test command (the probe) found the agent process and could not open its stdout or memory.
      assert.match(report.checks['agent channel closed'].detail, /^agent pid \d+: fd\/1 (EACCES|EPERM), mem (EACCES|EPERM)$/)
      assert.equal(report.checks['proxy refuses another TLS name'].ok, true)
      assert.equal(
        fs.existsSync(path.join(dir, '.git', 'worktrees')) && fs.readdirSync(path.join(dir, '.git', 'worktrees')).length,
        false,
        'no git worktree',
      )
      assert.match(getComment(config, 'site', 1).replies.at(-1).body, /Budget: 3 of 20 turns/)
      const calls = model.calls
      assert.equal(calls.length, 3)
      assert.ok(
        calls.every((call) => call.authorization === `Bearer ${env.SHAPEWALL_AGENT_API_KEY}`),
        'the host added the key',
      )
      assert.ok(!JSON.stringify(report).includes(env.SHAPEWALL_AGENT_API_KEY), 'the sandbox never saw it')
      assert.ok(JSON.stringify(calls[1].body.messages).includes('refused'), '/etc/passwd was refused')
      // Nothing of the run is left: containers and its network.
      const left = await runtime.exec(['ps', '-a', '--filter', `label=shapewall.agent.run=${result.runId}`, '--format', '{{.Names}}'])
      assert.equal(left.stdout.trim(), '')
      assert.notEqual((await runtime.exec(['network', 'inspect', `shapewall-agent-${result.runId}`])).code, 0)
    } finally {
      listener.close()
      await model.close()
      await runtime.exec(['rm', '-f', stubName])
    }
  },
)
