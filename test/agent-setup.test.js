// `shapewall agent setup` (src/agent-setup.js), the Codex config.toml
// editor (src/codex-toml.js) and the command resolver
// (src/shapewall-command.js). Every write goes to a scratch HOME,
// CLAUDE_CONFIG_DIR and CODEX_HOME; fake `claude` and `codex` binaries on
// PATH record their argv (test/fixtures/fake-agent-cli.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { compareVersions, pathInstall, projectInstall, resolveShapewallCommand, skipPathDir } from '../src/shapewall-command.js'
import { checkEdit, keyParts, parseValue, readServer, removeServer, scanToml, setServer } from '../src/codex-toml.js'
import {
  applySetup,
  backupDir,
  claudeCommand,
  claudeEntries,
  isOlderShapewall,
  lineDiff,
  planSetup,
  pruneBackups,
} from '../src/agent-setup.js'
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

// ---- review fixes (PR 23)

// A shapewall package claiming `version`, installed the way npm does into <root>/node_modules
// (bin linked from node_modules/.bin). Returns the .bin folder.
function npmInstall(root, version) {
  const pkg = path.join(root, 'node_modules', 'shapewall')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'shapewall', version }))
  fs.writeFileSync(path.join(pkg, 'bin', 'shapewall.js'), '#!/bin/sh\necho not this one\n', { mode: 0o755 })
  const bin = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync('../shapewall/bin/shapewall.js', path.join(bin, 'shapewall'))
  return bin
}

test('global reach never names a project install or the npx cache, with PATH built the way npm exec and npx -y build it', () => {
  const box = machine('resolve-npm-exec', { claude: false, shapewall: '99.0.0' })
  // A monorepo: the project inside a workspace root, each with its own install (newer than this version).
  const workspace = path.join(box.root, 'workspace')
  const dir = path.join(workspace, 'packages', 'app')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), '{}')
  const ownBin = npmInstall(dir, '99.0.0')
  const rootBin = npmInstall(workspace, '99.0.0')
  // npx -y: ~/.npm/_npx/<hash>/node_modules/.bin goes first.
  const npxBin = npmInstall(path.join(box.home, '.npm', '_npx', '0123456789abcdef'), '99.0.0')
  // A folder of scripts inside the project.
  const scripts = path.join(dir, 'bin')
  fs.mkdirSync(scripts)
  fs.symlinkSync(path.join(ownBin, 'shapewall'), path.join(scripts, 'shapewall'))
  // npm exec / npm run: <project>/node_modules/.bin, then every ancestor's, then npm's node-gyp-bin, then PATH.
  const ancestors = []
  for (let at = path.join(dir, 'packages'); ; at = path.dirname(at)) {
    ancestors.push(path.join(at, 'node_modules', '.bin'))
    if (path.dirname(at) === at) break
  }
  const npmExec = [npxBin, ownBin, path.join(dir, 'packages', 'node_modules', '.bin'), ...ancestors, scripts]
  assert.ok(npmExec.includes(rootBin))
  const gyp = path.join(box.root, 'npm', 'node_modules', '@npmcli', 'run-script', 'lib', 'node-gyp-bin')
  const pick = (reach, PATH) => resolveShapewallCommand({ projectDir: dir, version: VERSION, reach, env: { ...box.env, PATH } }).command
  const npx = 'npx'
  assert.equal(pick('global', [...npmExec, gyp].join(':')), npx)
  // The real global install after them is the one named.
  assert.equal(pick('global', [...npmExec, gyp, box.bin].join(':')), path.join(box.bin, 'shapewall'))
  // Local reach: the project's own install first, as before; the npx cache never.
  assert.equal(pick('local', [npxBin, box.bin].join(':')), path.join(ownBin, 'shapewall'))
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
  assert.equal(pick('local', [npxBin].join(':')), npx)
  // Through a symbolic link to the cache too.
  const linked = path.join(box.root, 'cache-link')
  fs.symlinkSync(npxBin, linked)
  assert.equal(pick('local', linked), npx)
  // And what agent setup writes for Codex from inside `npx shapewall agent setup`.
  const plan = planSetup({ dir, flags: { codex: true }, version: VERSION, env: { ...box.env, PATH: [npxBin, rootBin, gyp].join(':') } })
  assert.deepEqual(plan.plans[0].after.args, ['-y', `shapewall@${VERSION}`, 'mcp'])
  // Windows paths: the cache and node_modules are spotted there too.
  assert.equal(skipPathDir('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\.bin', { platform: 'win32' }), true)
  assert.equal(skipPathDir('C:\\work\\app\\node_modules\\.bin', { reach: 'global', platform: 'win32' }), true)
  assert.equal(skipPathDir('C:\\work\\app\\node_modules\\.bin', { reach: 'local', platform: 'win32' }), false)
  assert.equal(skipPathDir('C:\\Work\\App\\tools', { reach: 'global', projectDir: 'c:\\work\\app', platform: 'win32' }), true)
  assert.equal(skipPathDir('C:\\Program Files\\nodejs', { reach: 'global', projectDir: 'c:\\work\\app', platform: 'win32' }), false)
})

test('Windows: project scope commits plain npx; local and user scope run .cmd programs through cmd /c', () => {
  const box = machine('setup-windows', { codex: false })
  const win = (scope) => planSetup({ dir: box.dir, flags: { claude: true, scope }, version: VERSION, env: box.env, platform: 'win32' })
  const pinned = ['-y', `shapewall@${VERSION}`, 'mcp']
  assert.deepEqual(
    { command: win('project').plans[0].after.command, args: win('project').plans[0].after.args },
    { command: 'npx', args: pinned },
  )
  for (const scope of ['local', 'user']) {
    const { after } = win(scope).plans[0]
    assert.deepEqual({ command: after.command, args: after.args }, { command: 'cmd', args: ['/c', 'npx.cmd', ...pinned] })
  }
  assert.equal(
    resolveShapewallCommand({ projectDir: box.dir, version: VERSION, reach: 'project', platform: 'win32', env: {} }).command,
    'npx',
  )
  assert.equal(
    resolveShapewallCommand({ projectDir: box.dir, version: VERSION, reach: 'global', platform: 'win32', env: {} }).command,
    'npx.cmd',
  )
  // An npm shim found by path: wrapped too; an .exe is not.
  assert.deepEqual(claudeCommand({ command: 'C:\\npm\\shapewall.cmd', args: [] }, { scope: 'local', platform: 'win32' }), {
    command: 'cmd',
    args: ['/c', 'C:\\npm\\shapewall.cmd'],
  })
  assert.deepEqual(claudeCommand({ command: 'C:\\bin\\shapewall.exe', args: [] }, { scope: 'user', platform: 'win32' }), {
    command: 'C:\\bin\\shapewall.exe',
    args: [],
  })
  assert.deepEqual(claudeCommand({ command: 'npx', args: ['x'] }, { scope: 'local', platform: 'linux' }), { command: 'npx', args: ['x'] })
  // A wrapped older registration is an upgrade, not a different server.
  assert.equal(
    isOlderShapewall({ command: 'cmd', args: ['/c', 'npx', '-y', 'shapewall@0.1.0', 'mcp'] }, { tail: ['mcp'], version: VERSION }),
    true,
  )
})

test('an older Shapewall entry is updated without --force; a newer, tagged or different one is not', async () => {
  const older = (entry, tail = ['mcp']) => isOlderShapewall(entry, { tail, version: VERSION })
  assert.equal(older({ command: 'npx', args: ['-y', 'shapewall@0.9.0', 'mcp'] }), true)
  assert.equal(older({ command: 'npx', args: ['shapewall', 'mcp'] }), true)
  assert.equal(older({ command: 'npx', args: ['-y', `shapewall@${VERSION}`, 'mcp'] }), true)
  assert.equal(older({ command: 'npx', args: ['-y', 'shapewall@99.0.0', 'mcp'] }), false)
  assert.equal(older({ command: 'npx', args: ['-y', 'shapewall@latest', 'mcp'] }), false)
  assert.equal(older({ command: 'npx', args: ['-y', 'shapewall@0.9.0', 'mcp', '--remote', 'https://x.example'] }), false)
  assert.equal(older({ command: 'npx', args: ['-y', 'other@0.9.0', 'mcp'] }), false)
  assert.equal(older({ command: '/gone/bin/shapewall', args: ['mcp'] }), true)
  assert.equal(older({ command: 'node', args: ['/x/shapewall.js', 'mcp'] }), false)
  assert.equal(older({ type: 'http', command: 'npx', args: ['shapewall', 'mcp'] }), false)

  const box = machine('setup-upgrade', { shapewall: '99.0.0' })
  const shapewall = path.join(box.bin, 'shapewall')
  fs.writeFileSync(
    box.codexFile,
    '[mcp_servers.shapewall]\ncommand = "npx"\nargs = ["-y", "shapewall@0.1.0", "mcp"]\ntool_timeout_sec = 600\n',
  )
  fs.writeFileSync(
    box.claudeFile,
    JSON.stringify({
      projects: {
        [fs.realpathSync(box.dir)]: { mcpServers: { shapewall: { type: 'stdio', command: '/old/shapewall', args: ['mcp'], env: {} } } },
      },
    }),
  )
  const result = await setup(box, { yes: true })
  assert.equal(result.code, 0, result.out + result.err)
  assert.doesNotMatch(result.out, /--force/)
  assert.equal(claudeEntries(box.dir, box.env).local.command, shapewall)
  assert.equal(readServer(fs.readFileSync(box.codexFile, 'utf8')).command, shapewall)
})

test('a symbolic link to config.toml or .mcp.json stays a link; the file it points to is changed', async () => {
  const box = machine('setup-symlink', { claude: false, shapewall: '99.0.0' })
  const dotfiles = path.join(box.root, 'dotfiles')
  fs.mkdirSync(dotfiles)
  fs.writeFileSync(path.join(dotfiles, 'config.toml'), 'model = "o3"\n', { mode: 0o640 })
  fs.symlinkSync(path.join(dotfiles, 'config.toml'), box.codexFile)
  const result = await setup(box, { codex: true, yes: true })
  assert.equal(result.code, 0, result.err)
  assert.equal(fs.lstatSync(box.codexFile).isSymbolicLink(), true)
  assert.equal(readServer(fs.readFileSync(path.join(dotfiles, 'config.toml'), 'utf8')).command, path.join(box.bin, 'shapewall'))
  assert.equal(fs.statSync(path.join(dotfiles, 'config.toml')).mode & 0o777, 0o640)
  assert.deepEqual(
    fs.readdirSync(dotfiles).filter((name) => name.endsWith('.tmp')),
    [],
  )

  const bare = machine('setup-symlink-mcp', { claude: false, codex: false })
  const shared = path.join(bare.root, 'shared.mcp.json')
  fs.writeFileSync(shared, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
  fs.symlinkSync(shared, path.join(bare.dir, '.mcp.json'))
  const project = await setup(bare, { claude: true, scope: 'project', yes: true })
  assert.equal(project.code, 0, project.err)
  assert.equal(fs.lstatSync(path.join(bare.dir, '.mcp.json')).isSymbolicLink(), true)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(shared, 'utf8')).mcpServers), ['other', 'shapewall'])
})

test('a failed Claude Code update puts the old entry back and names the backup; a changed entry is not overwritten', async () => {
  const box = machine('setup-rollback', { codex: false, shapewall: '99.0.0' })
  const old = { type: 'stdio', command: '/mine/server', args: ['--x'], env: {} }
  fs.writeFileSync(box.claudeFile, JSON.stringify({ projects: { [fs.realpathSync(box.dir)]: { mcpServers: { shapewall: old } } } }))
  box.env.FAKE_CLAUDE_FAIL_COMMAND = path.join(box.bin, 'shapewall')
  const result = await setup(box, { yes: true, force: true })
  assert.equal(result.code, 1)
  assert.match(result.err, /claude mcp add-json failed: add-json failed on purpose\. The old entry was put back\./)
  assert.match(result.err, /Backup of the file before the change: ~\/\.claude\/\.claude\.json\.shapewall-backup-/)
  assert.deepEqual(claudeEntries(box.dir, box.env).local, old)
  delete box.env.FAKE_CLAUDE_FAIL_COMMAND

  // The entry changes between the plan and the write: nothing is run.
  const plan = planSetup({ dir: box.dir, flags: { claude: true, force: true }, version: VERSION, env: box.env })
  const data = JSON.parse(fs.readFileSync(box.claudeFile, 'utf8'))
  data.projects[fs.realpathSync(box.dir)].mcpServers.shapewall.args = ['--y']
  fs.writeFileSync(box.claudeFile, JSON.stringify(data))
  const calls = box.calls().length
  const [applied] = await applySetup(plan, { dir: box.dir, env: box.env })
  assert.equal(applied.ok, false)
  assert.match(applied.error, /changed while Shapewall was asking/)
  assert.equal(box.calls().length, calls)
})

test('backups: ~/.claude.json keeps the newest 3; a project .mcp.json is backed up outside the project', async () => {
  const box = machine('setup-backups', { codex: false })
  fs.writeFileSync(box.claudeFile, JSON.stringify({ numStartups: 1 }))
  for (const [index, scope] of ['local', 'user', 'local', 'user', 'local'].entries()) {
    const flags = { claude: true, scope, yes: true }
    if (index > 1) flags.remove = true
    await setup(box, flags)
  }
  const names = fs.readdirSync(box.env.CLAUDE_CONFIG_DIR).filter((name) => name.includes('.shapewall-backup-'))
  assert.equal(names.length, 3)
  // A backup someone named themselves is not Shapewall's to prune.
  fs.writeFileSync(path.join(box.env.CLAUDE_CONFIG_DIR, '.claude.json.shapewall-backup-mine'), '{}')
  pruneBackups(box.env.CLAUDE_CONFIG_DIR, '.claude.json', 1)
  assert.deepEqual(
    fs
      .readdirSync(box.env.CLAUDE_CONFIG_DIR)
      .filter((name) => name.includes('.shapewall-backup-'))
      .sort(),
    [names.sort().at(-1), '.claude.json.shapewall-backup-mine'].sort(),
  )

  fs.writeFileSync(path.join(box.dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
  const project = await setup(box, { claude: true, scope: 'project', yes: true })
  assert.equal(project.code, 0, project.err)
  assert.deepEqual(
    fs.readdirSync(box.dir).filter((name) => name.includes('backup')),
    [],
  )
  const kept = fs.readdirSync(backupDir(box.env))
  assert.equal(kept.length, 1)
  assert.match(kept[0], /^project-[0-9a-f]{8}\.mcp\.json\.shapewall-backup-/)
  assert.ok(backupDir(box.env).startsWith(path.join(box.home, '.local', 'state', 'shapewall')))
})

test('a --force update says that the entry env values go on the claude command line', async () => {
  const box = machine('setup-env-note', { codex: false, shapewall: '99.0.0' })
  fs.writeFileSync(
    box.claudeFile,
    JSON.stringify({
      projects: { [fs.realpathSync(box.dir)]: { mcpServers: { shapewall: { command: 'x', args: [], env: { A: '1' } } } } },
    }),
  )
  const dry = await setup(box, { 'dry-run': true, force: true })
  assert.match(dry.out, /keeps its env values; they are passed to "claude mcp add-json" on its command line/)
})

// The reviewer's two repro files: an escaped """ inside a multi-line basic string.
const ESCAPED_A = '[a]\nx = """a \\""" b"""\n[mcp_servers.shapewall]\ncommand = "old"\n[b]\nw = """c \\""" d"""\n'
const ESCAPED_B = '[notes]\nnote = """see \\""" here\n[mcp_servers.shapewall]\ncommand = "evil"\n# """\n[keep]\nk = 1\n'

// Python's tomllib (3.11+) as the reference reader, when there is one; undefined otherwise.
const HAS_TOMLLIB = (() => {
  try {
    execFileSync('python3', ['-I', '-c', 'import tomllib'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
function tomllib(text) {
  if (!HAS_TOMLLIB) return undefined
  const script = 'import sys,tomllib,json;print(json.dumps(tomllib.loads(sys.stdin.read())))'
  return JSON.parse(execFileSync('python3', ['-I', '-c', script], { input: text, stdio: ['pipe', 'pipe', 'pipe'] }).toString())
}

test('codex TOML: \\""" inside """ does not end the string (the two review repros)', () => {
  const set = { command: '/usr/bin/shapewall', args: ['mcp'], tool_timeout_sec: 600 }
  // (a) the real entry sits between two such strings: found, updated and removed, the strings untouched.
  assert.deepEqual(readServer(ESCAPED_A), { command: 'old' })
  const setA = setServer(ESCAPED_A, set)
  assert.equal(
    setA,
    '[a]\nx = """a \\""" b"""\n[mcp_servers.shapewall]\ncommand = "/usr/bin/shapewall"\nargs = ["mcp"]\ntool_timeout_sec = 600\n[b]\nw = """c \\""" d"""\n',
  )
  assert.equal(removeServer(ESCAPED_A), '[a]\nx = """a \\""" b"""\n[b]\nw = """c \\""" d"""\n')
  // (b) a header inside a string is not our entry: --remove leaves the file alone, setting appends a real one.
  assert.equal(readServer(ESCAPED_B), null)
  assert.equal(removeServer(ESCAPED_B), ESCAPED_B)
  const setB = setServer(ESCAPED_B, set)
  assert.ok(setB.startsWith(ESCAPED_B))
  const parsed = tomllib(setB)
  if (parsed !== undefined) {
    assert.deepEqual(parsed.mcp_servers.shapewall, set)
    assert.match(parsed.notes.note, /command = "evil"/)
    assert.deepEqual(tomllib(setA).b, { w: 'c """ d' })
  }
})

test('codex TOML: every edit is read back; one that would change other lines is refused', () => {
  assert.doesNotThrow(() => checkEdit('[x]\na = 1\n', '[x]\na = 1\n\n[mcp_servers.shapewall]\ncommand = "s"\n', { command: 's' }))
  assert.throws(
    () => checkEdit('[x]\na = 1\n', '[x]\na = 2\n\n[mcp_servers.shapewall]\ncommand = "s"\n', { command: 's' }),
    /could not change \[mcp_servers\.shapewall\] safely \(it would change the line "a = 1"\)/,
  )
  assert.throws(() => checkEdit('[x]\na = 1\n', '[x]\na = 1\n', { command: 's' }), /the entry is missing/)
  assert.throws(() => checkEdit('[x]\r\na = 1\r\n', '[x]\na = 1\n', { command: 's' }), /would change the line/)
  assert.throws(() => checkEdit('a = 1\n', 'a = """\n', null), /does not read back/)
})

test('codex TOML: removing the entry keeps the comment above the next table; mixed line endings stay', () => {
  const source = '[mcp_servers.shapewall]\ncommand = "a"\n\n# GitHub server: do not remove\n[mcp_servers.github]\ncommand = "gh"\n'
  assert.equal(removeServer(source), '# GitHub server: do not remove\n[mcp_servers.github]\ncommand = "gh"\n')
  // A comment above our own subtable is ours.
  assert.equal(
    removeServer('[mcp_servers.shapewall]\ncommand = "a"\n# env\n[mcp_servers.shapewall.env]\nA = "1"\n[k]\nx = 1\n'),
    '[k]\nx = 1\n',
  )
  const mixed = '# top\r\nmodel = "x"\n\n[mcp_servers.shapewall]\r\ncommand = "a"\r\n\r\n[keep]\nk = 1\r\n'
  const set = setServer(mixed, { command: 'b', tool_timeout_sec: 600 })
  assert.equal(set, '# top\r\nmodel = "x"\n\n[mcp_servers.shapewall]\r\ncommand = "b"\r\ntool_timeout_sec = 600\r\n\r\n[keep]\nk = 1\r\n')
  assert.equal(removeServer(mixed), '# top\r\nmodel = "x"\n\n[keep]\nk = 1\r\n')
})
