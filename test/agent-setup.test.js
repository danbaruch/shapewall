// `shapewall agent setup` (src/agent-setup.js), the Codex config.toml
// editor (src/codex-toml.js) and the command resolver
// (src/shapewall-command.js). Every write goes to a scratch HOME,
// CLAUDE_CONFIG_DIR and CODEX_HOME; fake `claude` and `codex` binaries on
// PATH record their argv (test/fixtures/fake-agent-cli.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions, pathInstall, projectInstall, resolveShapewallCommand } from '../src/shapewall-command.js'
import { keyParts, parseValue, readServer, removeServer, scanToml, setServer } from '../src/codex-toml.js'
import { claudeEntries, lineDiff, planSetup } from '../src/agent-setup.js'
import { agentSetupCommand } from '../src/cli/agent-setup-command.js'
import { saveCredential } from '../src/remote/credentials.js'
import { tempDir } from './helpers.js'

const FAKE = path.resolve('test/fixtures/fake-agent-cli.mjs')
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version

// A scratch machine: HOME, the two agent config dirs, a project with a config, and a PATH with only
// node and the CLIs asked for.
function machine(name, { claude = true, codex = true, shapewall = null } = {}) {
  const root = tempDir(name)
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const dir = path.join(root, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(bin)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), '{}')
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  if (claude) fs.symlinkSync(FAKE, path.join(bin, 'claude'))
  if (codex) fs.symlinkSync(FAKE, path.join(bin, 'codex'))
  if (shapewall) {
    const pkg = path.join(root, 'global', 'lib', 'node_modules', 'shapewall')
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'shapewall', version: shapewall }))
    fs.writeFileSync(path.join(pkg, 'bin', 'shapewall.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    fs.symlinkSync(path.join(pkg, 'bin', 'shapewall.js'), path.join(bin, 'shapewall'))
  }
  const env = {
    HOME: home,
    PATH: bin,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    FAKE_CLI_LOG: path.join(root, 'argv.log'),
  }
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR)
  fs.mkdirSync(env.CODEX_HOME)
  const calls = () =>
    fs.existsSync(env.FAKE_CLI_LOG)
      ? fs
          .readFileSync(env.FAKE_CLI_LOG, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
  return {
    root,
    home,
    bin,
    dir,
    env,
    calls,
    codexFile: path.join(env.CODEX_HOME, 'config.toml'),
    claudeFile: path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'),
  }
}

async function setup(box, flags = {}, options = {}) {
  const out = []
  const err = []
  const cwd = process.cwd()
  process.chdir(box.dir)
  try {
    const code = await agentSetupCommand(
      flags,
      (line) => out.push(line),
      (line) => err.push(line),
      {
        env: box.env,
        interactive: false,
        ...options,
      },
    )
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    process.chdir(cwd)
  }
}

// ---- resolver

test('versions compare numerically, a prerelease before its release', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0)
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1)
  assert.equal(compareVersions('2.0.0', 'x'), null)
})

test('resolver order: the project install, then PATH at or above this version, then the pinned npx', () => {
  const box = machine('resolve', { shapewall: '99.0.0' })
  const npx = { command: 'npx', args: ['-y', `shapewall@${VERSION}`], how: 'npx' }
  const pick = (reach, env = box.env) => {
    const { command, args, how } = resolveShapewallCommand({ projectDir: box.dir, version: VERSION, reach, env })
    return { command, args, how }
  }
  // No project install: PATH (absolute), except where it would be committed.
  assert.deepEqual(pick('local'), { command: path.join(box.bin, 'shapewall'), args: [], how: 'path' })
  assert.deepEqual(pick('global'), { command: path.join(box.bin, 'shapewall'), args: [], how: 'path' })
  assert.deepEqual(pick('project'), npx)
  // An older one on PATH is passed over.
  const old = machine('resolve-old', { shapewall: '0.9.0' })
  assert.equal(pathInstall(old.env).version, '0.9.0')
  assert.equal(resolveShapewallCommand({ projectDir: old.dir, version: VERSION, env: old.env }).how, 'npx')
  assert.match(resolveShapewallCommand({ projectDir: old.dir, version: VERSION, env: old.env }).note, /older/)
  // A relative PATH entry never counts.
  assert.equal(pathInstall({ PATH: `.:bin:${''}` }), null)
  // The project's own install.
  const own = path.join(box.dir, 'node_modules')
  fs.mkdirSync(path.join(own, '.bin'), { recursive: true })
  fs.mkdirSync(path.join(own, 'shapewall'))
  fs.writeFileSync(path.join(own, 'shapewall', 'package.json'), JSON.stringify({ name: 'shapewall', version: '1.0.0' }))
  fs.writeFileSync(path.join(own, '.bin', 'shapewall'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(projectInstall(box.dir).version, '1.0.0')
  assert.deepEqual(pick('local'), { command: path.join(own, '.bin', 'shapewall'), args: [], how: 'project' })
  assert.deepEqual(pick('project'), { command: 'npx', args: ['shapewall'], how: 'project' })
  // Global registrations never name one project's install.
  assert.equal(pick('global').how, 'path')
  assert.deepEqual(pick('global', { PATH: path.join(box.root, 'nothing') }), npx)
})

// ---- the Codex TOML editor

const CODEX = [
  '# my settings',
  'model = "gpt"',
  '',
  '[mcp_servers.node_repl]',
  'command = "/usr/lib/thing"',
  'args = [',
  '  "a", # a comment with [brackets]',
  '  "[not.a.header]",',
  ']',
  'note = """',
  '[mcp_servers.shapewall]',
  '"""',
  '',
  '[profiles.fast]',
  "model = 'x'",
  '',
].join('\n')

test('codex TOML: reads headers outside strings and arrays; a file without the entry gets it at the end', () => {
  assert.deepEqual(keyParts('mcp_servers."shape wall"'), ['mcp_servers', 'shape wall'])
  assert.deepEqual(parseValue(' ["a", \'b\', 3, true] # c'), ['a', 'b', 3, true])
  assert.equal(parseValue(' { a = 1 }'), undefined)
  assert.equal(readServer(CODEX), null)
  assert.equal(scanToml(CODEX).filter((line) => line.kind === 'header').length, 2)
  const text = setServer(CODEX, { command: 'shapewall', args: ['mcp'], tool_timeout_sec: 600 })
  assert.ok(text.startsWith(CODEX.replace(/\n$/, '')))
  assert.equal(text.slice(CODEX.length - 1), '\n\n[mcp_servers.shapewall]\ncommand = "shapewall"\nargs = ["mcp"]\ntool_timeout_sec = 600\n')
  assert.deepEqual(readServer(text), { command: 'shapewall', args: ['mcp'], tool_timeout_sec: 600 })
  // Removing it gives the file back byte for byte.
  assert.equal(removeServer(text), CODEX)
})

test('codex TOML: an existing entry is updated in place; its other keys, comments and subtables stay', () => {
  const source = [
    '[mcp_servers.shapewall]',
    '# mine',
    'command = "npx"',
    'args = [',
    '  "shapewall",',
    '  "mcp",',
    ']',
    'enabled = true',
    '',
    '[mcp_servers.shapewall.env]',
    'FOO = "1"',
    '',
    '[other]',
    'x = 1',
    '',
  ].join('\r\n')
  const text = setServer(source, { command: '/bin/shapewall', args: ['mcp'], tool_timeout_sec: 600 })
  assert.equal(
    text,
    [
      '[mcp_servers.shapewall]',
      '# mine',
      'command = "/bin/shapewall"',
      'args = ["mcp"]',
      'enabled = true',
      'tool_timeout_sec = 600',
      '',
      '[mcp_servers.shapewall.env]',
      'FOO = "1"',
      '',
      '[other]',
      'x = 1',
      '',
    ].join('\r\n'),
  )
  assert.equal(removeServer(text), ['[other]', 'x = 1', ''].join('\r\n'))
})

test('codex TOML: forms Shapewall does not edit are refused', () => {
  assert.throws(() => setServer('mcp_servers = { shapewall = { command = "x" } }\n', { command: 'y' }), /inline table/)
  assert.throws(() => setServer('[mcp_servers]\nshapewall = { command = "x" }\n', { command: 'y' }), /edit it by hand/)
  assert.throws(() => setServer('[mcp_servers.shapewall]\ncommand = "a"\n[mcp_servers.shapewall]\n', { command: 'y' }), /twice/)
  assert.throws(() => setServer('[[mcp_servers.shapewall]]\n', { command: 'y' }), /array of tables/)
  assert.throws(() => setServer('args = [\n "a",\n', { command: 'y' }), /ends inside/)
})

test('lineDiff marks what changed', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), ['  a', '+ B', '- b', '  c', '+ d'])
})

// ---- agent setup

test('agent setup: Claude Code local scope and Codex, after a yes; argv, files and backups', async () => {
  const box = machine('setup-both', { shapewall: '99.0.0' })
  fs.writeFileSync(box.codexFile, CODEX)
  fs.writeFileSync(box.claudeFile, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }))
  const dry = await setup(box, { 'dry-run': true })
  assert.equal(dry.code, 0)
  assert.match(
    dry.out,
    /Claude Code \(local scope: this project, only you, ~\/\.claude\/\.claude\.json\):\n {2}add shapewall: \S+\/bin\/shapewall mcp/,
  )
  assert.match(dry.out, /\+ tool_timeout_sec = 600/)
  assert.match(dry.out, /Dry run: nothing was written/)
  assert.deepEqual(box.calls(), [])
  assert.equal(fs.readFileSync(box.codexFile, 'utf8'), CODEX)

  // No terminal and no --yes: nothing is written.
  const refused = await setup(box, {})
  assert.equal(refused.code, 1)
  assert.match(refused.err, /Add --yes/)
  assert.deepEqual(box.calls(), [])

  // A "no" at the question: nothing either.
  const no = await setup(box, {}, { interactive: true, ask: async () => false })
  assert.equal(no.code, 1)
  assert.deepEqual(box.calls(), [])

  const yes = await setup(box, {}, { interactive: true, ask: async () => true })
  assert.equal(yes.code, 0, yes.err)
  const shapewall = path.join(box.bin, 'shapewall')
  const [add, get] = box.calls()
  assert.equal(add.name, 'claude')
  assert.deepEqual(add.args.slice(0, 4), ['mcp', 'add-json', '-s', 'local'])
  assert.equal(add.args[4], 'shapewall')
  assert.deepEqual(JSON.parse(add.args[5]), { type: 'stdio', command: shapewall, args: ['mcp'], env: {} })
  assert.equal(fs.realpathSync(add.cwd), fs.realpathSync(box.dir))
  assert.deepEqual(get.args, ['mcp', 'get', 'shapewall', '--json'])
  // Never a token on a command line.
  assert.doesNotMatch(JSON.stringify(box.calls()), /swp_/)
  assert.deepEqual(claudeEntries(box.dir, box.env).local, { type: 'stdio', command: shapewall, args: ['mcp'], env: {} })
  const claude = JSON.parse(fs.readFileSync(box.claudeFile, 'utf8'))
  assert.equal(claude.numStartups, 3)
  assert.deepEqual(claude.mcpServers, { other: { command: 'x' } })
  const codex = fs.readFileSync(box.codexFile, 'utf8')
  assert.ok(codex.startsWith(CODEX.replace(/\n$/, '')))
  assert.deepEqual(readServer(codex), { command: shapewall, args: ['mcp'], tool_timeout_sec: 600 })
  // Both files were backed up before the change.
  const backups = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.shapewall-backup-'))
  assert.equal(backups(box.env.CODEX_HOME).length, 1)
  assert.equal(fs.readFileSync(path.join(box.env.CODEX_HOME, backups(box.env.CODEX_HOME)[0]), 'utf8'), CODEX)
  assert.equal(backups(box.env.CLAUDE_CONFIG_DIR).length, 1)
  assert.match(yes.out, /Next: open Claude Code or Codex/)

  // Idempotent: a second run has nothing to write and runs nothing.
  const before = box.calls().length
  const again = await setup(box, { yes: true })
  assert.equal(again.code, 0)
  assert.match(again.out, /shapewall is already set up/)
  assert.match(again.out, /\[mcp_servers\.shapewall\] is already set up/)
  assert.equal(box.calls().length, before)
})

test('agent setup: a different entry is shown and replaced only with --force; a timeout the person set stays', async () => {
  const box = machine('setup-differs', { shapewall: '99.0.0' })
  const shapewall = path.join(box.bin, 'shapewall')
  fs.writeFileSync(
    box.codexFile,
    '[mcp_servers.shapewall]\ncommand = "npx"\nargs = ["shapewall", "mcp", "--config", "/p/shapewall.config.json"]\ntool_timeout_sec = 900\n',
  )
  fs.writeFileSync(
    box.claudeFile,
    JSON.stringify({
      projects: { [fs.realpathSync(box.dir)]: { mcpServers: { shapewall: { type: 'stdio', command: 'old', args: [], env: { A: '1' } } } } },
    }),
  )
  const plain = await setup(box, { yes: true })
  assert.equal(plain.code, 1)
  assert.equal((plain.out.match(/A different shapewall server is there/g) || []).length, 2)
  assert.deepEqual(box.calls(), [])

  const forced = await setup(box, { yes: true, force: true })
  assert.equal(forced.code, 0, forced.err)
  assert.deepEqual(
    box
      .calls()
      .filter((call) => call.name === 'claude')
      .map((call) => call.args.slice(1, 4)),
    [
      ['remove', '-s', 'local'],
      ['add-json', '-s', 'local'],
    ],
  )
  // The person's env stays on the Claude entry; their timeout on the Codex one.
  assert.deepEqual(claudeEntries(box.dir, box.env).local, { type: 'stdio', command: shapewall, args: ['mcp'], env: { A: '1' } })
  assert.deepEqual(readServer(fs.readFileSync(box.codexFile, 'utf8')), { command: shapewall, args: ['mcp'], tool_timeout_sec: 900 })
})

test('agent setup: an entry that only lacks tool_timeout_sec gets it, no --force needed', async () => {
  const box = machine('setup-timeout', { claude: false, shapewall: '99.0.0' })
  const shapewall = path.join(box.bin, 'shapewall')
  fs.writeFileSync(box.codexFile, `[mcp_servers.shapewall]\ncommand = ${JSON.stringify(shapewall)}\nargs = ["mcp"]\n`)
  const result = await setup(box, { yes: true })
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /\+ tool_timeout_sec = 600/)
  assert.equal(readServer(fs.readFileSync(box.codexFile, 'utf8')).tool_timeout_sec, 600)
})

test('agent setup: --scope user and --scope project; the CLI-less project fallback writes .mcp.json', async () => {
  const box = machine('setup-scopes', { codex: false })
  const user = await setup(box, { claude: true, scope: 'user', yes: true })
  assert.equal(user.code, 0, user.err)
  // Every project of yours: never one project's install, so the pinned npx here.
  assert.deepEqual(claudeEntries(box.dir, box.env).user.args, ['-y', `shapewall@${VERSION}`, 'mcp'])

  const project = await setup(box, { claude: true, scope: 'project', yes: true })
  assert.equal(project.code, 0, project.err)
  assert.match(project.out, /asks each person to approve/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box.dir, '.mcp.json'), 'utf8')).mcpServers.shapewall.args, [
    '-y',
    `shapewall@${VERSION}`,
    'mcp',
  ])
  assert.match(project.out, /also a shapewall server at user scope \(the same\)/)

  const bare = machine('setup-no-cli', { claude: false, codex: false })
  fs.writeFileSync(path.join(bare.dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
  const written = await setup(bare, { claude: true, scope: 'project', yes: true })
  assert.equal(written.code, 0, written.err)
  const mcp = JSON.parse(fs.readFileSync(path.join(bare.dir, '.mcp.json'), 'utf8'))
  assert.deepEqual(Object.keys(mcp.mcpServers), ['other', 'shapewall'])
  // Without the CLI, local scope cannot be set: said, nothing written.
  const local = await setup(bare, { claude: true, yes: true })
  assert.equal(local.code, 1)
  assert.match(local.out, /claude command is not on PATH/)
  assert.equal(fs.existsSync(bare.claudeFile), false)

  await assert.rejects(setup(box, { scope: 'global' }), /--scope: local, user or project/)
})

test('agent setup --remove takes out only the shapewall entries', async () => {
  const box = machine('setup-remove', { shapewall: '99.0.0' })
  fs.writeFileSync(box.codexFile, CODEX)
  await setup(box, { yes: true })
  const removed = await setup(box, { remove: true, yes: true })
  assert.equal(removed.code, 0, removed.err)
  assert.equal(fs.readFileSync(box.codexFile, 'utf8'), CODEX)
  assert.equal(claudeEntries(box.dir, box.env).local, null)
  const nothing = await setup(box, { remove: true, yes: true })
  assert.match(nothing.out, /no shapewall server to remove/)
})

test('agent setup --remote: needs a saved login, registers mcp --remote URL, never the token', async () => {
  const box = machine('setup-remote', { codex: false, shapewall: '99.0.0' })
  const origin = 'https://board.example.com'
  await assert.rejects(
    setup(box, { remote: origin, yes: true }),
    /No saved login for https:\/\/board\.example\.com\. Run ".*login --remote/,
  )
  assert.deepEqual(box.calls(), [])
  const token = `swp_${'a'.repeat(43)}`
  saveCredential(origin, { token }, box.env)
  const result = await setup(box, { remote: `${origin}/w/x/`, yes: true })
  assert.equal(result.code, 0, result.err)
  assert.deepEqual(claudeEntries(box.dir, box.env).local.args, ['mcp', '--remote', origin])
  assert.doesNotMatch(fs.readFileSync(box.claudeFile, 'utf8'), /swp_/)
  assert.doesNotMatch(JSON.stringify(box.calls()), /swp_/)
  await assert.rejects(setup(box, { remote: 'http://example.com', yes: true }), /must be https/)
})

test('agent setup: no app found, no config, --json', async () => {
  const none = machine('setup-none', { claude: false, codex: false })
  fs.rmSync(none.env.CODEX_HOME, { recursive: true })
  const result = await setup(none, {})
  assert.equal(result.code, 1)
  assert.match(result.err, /Neither claude nor codex is on PATH/)

  const box = machine('setup-json', { codex: false, shapewall: '99.0.0' })
  const json = await setup(box, { json: true, 'dry-run': true })
  const data = JSON.parse(json.out)
  assert.equal(data.ok, true)
  assert.equal(data.plans[0].app, 'claude')
  assert.equal(data.plans[0].action, 'add')
  assert.equal(data.plans[0].source, undefined)

  fs.rmSync(path.join(box.dir, 'shapewall.config.json'))
  await assert.rejects(setup(box, {}), /No config at .*Run ".*init" first/)
})

test('planSetup picks the apps found: codex counts when its config folder exists without the CLI', () => {
  const box = machine('setup-pick', { claude: false, codex: false })
  assert.deepEqual(planSetup({ dir: box.dir, version: VERSION, env: box.env }).apps, ['codex'])
})
