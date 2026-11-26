// The plugin's MCP launcher (plugins/shapewall/bin/shapewall-mcp.mjs): its
// copy of the command resolver gives the same answers as
// src/shapewall-command.js on the same table (reach "local" with a project
// install, "global" without), skipPathDir is the same rule, it skips the
// PATH folders npm puts first for one project or one npx run, it finds the
// project folder, and it starts `shapewall mcp` (or `mcp --remote URL`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as source from '../src/shapewall-command.js'
import * as launcher from '../plugins/shapewall/bin/shapewall-mcp.mjs'
import { tempDir } from './helpers.js'

const LAUNCHER = path.resolve('plugins/shapewall/bin/shapewall-mcp.mjs')
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version

// A global install of `shapewall` at `version` under root/<name>, with its bin
// linked from root/<name>-bin; the bin can print its argv and folder.
function globalInstall(root, name, version) {
  const pkg = path.join(root, name, 'lib', 'node_modules', 'shapewall')
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'shapewall', version }))
  fs.writeFileSync(
    path.join(pkg, 'bin', 'shapewall.js'),
    `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), agentRun: process.env.SHAPEWALL_AGENT_RUN, agentHeader: process.env.SHAPEWALL_AGENT_HEADER }))\nprocess.exit(Number(process.env.FAKE_EXIT || 0))\n`,
    { mode: 0o755 },
  )
  const bin = path.join(root, `${name}-bin`)
  fs.mkdirSync(bin)
  fs.symlinkSync(path.join(pkg, 'bin', 'shapewall.js'), path.join(bin, 'shapewall'))
  return bin
}

// A project install of `shapewall` at `version`, the way npm makes one:
// node_modules/shapewall with its bin file, linked from node_modules/.bin.
function projectInstall(dir, version) {
  const own = path.join(dir, 'node_modules')
  fs.mkdirSync(path.join(own, '.bin'), { recursive: true })
  fs.mkdirSync(path.join(own, 'shapewall', 'bin'), { recursive: true })
  fs.writeFileSync(
    path.join(own, 'shapewall', 'package.json'),
    JSON.stringify({ name: 'shapewall', version, bin: { shapewall: 'bin/shapewall.js' } }),
  )
  fs.writeFileSync(path.join(own, 'shapewall', 'bin', 'shapewall.js'), '#!/bin/sh\n', { mode: 0o755 })
  fs.symlinkSync('../shapewall/bin/shapewall.js', path.join(own, '.bin', 'shapewall'))
  return path.join(own, '.bin', 'shapewall')
}

// A project folder with a config, the root of its own repository (.git).
function box(name) {
  const root = tempDir(name)
  const dir = path.join(root, 'project')
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), '{}')
  return { root, dir }
}

const pick = ({ command, args, how }) => ({ command, args, how })

test('the launcher pins the package version', () => {
  assert.equal(launcher.PINNED, VERSION)
})

// The launcher's answer is src/shapewall-command.js's: reach "local" when the
// project installs shapewall (step 1), reach "global" when it does not (the
// plugin is installed once for every project, so its PATH step skips what a
// global registration skips).
const sourceAnswer = (projectDir, env, platform = 'linux') => {
  const own = source.projectInstall(projectDir, { platform, version: VERSION })
  const reach = own && !own.refused ? 'local' : launcher.PATH_REACH
  return source.resolveShapewallCommand({ projectDir, version: VERSION, reach, env, platform })
}

test('the launcher resolver answers the shared table like src/shapewall-command.js', () => {
  const { root, dir } = box('launcher-table')
  const newer = globalInstall(root, 'new', '99.0.0')
  const older = globalInstall(root, 'old', '0.9.0')
  const empty = path.join(root, 'nothing')
  // A newer shapewall in another project's node_modules/.bin, and one in a folder inside this project.
  const otherProject = path.join(root, 'other', 'node_modules', '.bin')
  fs.mkdirSync(otherProject, { recursive: true })
  fs.symlinkSync(path.join(newer, 'shapewall'), path.join(otherProject, 'shapewall'))
  const inside = path.join(dir, 'tools')
  fs.mkdirSync(inside)
  fs.symlinkSync(path.join(newer, 'shapewall'), path.join(inside, 'shapewall'))
  const rows = [
    { name: 'PATH at or above this version', env: { PATH: newer } },
    { name: 'PATH older', env: { PATH: older } },
    { name: 'older first, newer after', env: { PATH: `${older}:${newer}` } },
    { name: 'no shapewall anywhere', env: { PATH: empty } },
    { name: 'relative PATH entries', env: { PATH: `.:bin:${newer}` } },
    { name: "another project's install only", env: { PATH: otherProject } },
    { name: 'a folder inside the project only', env: { PATH: inside } },
  ]
  const answers = (projectDir) =>
    rows.map((row) => {
      const ours = launcher.resolveShapewallCommand({ projectDir, version: VERSION, env: row.env, platform: 'linux' })
      assert.deepEqual(ours, sourceAnswer(projectDir, row.env), row.name)
      return pick(ours)
    })
  // Without a project install: PATH when new enough, else the pinned npx.
  const npx = { command: 'npx', args: ['-y', `shapewall@${VERSION}`], how: 'npx' }
  const onPath = { command: path.join(newer, 'shapewall'), args: [], how: 'path' }
  assert.deepEqual(answers(dir), [onPath, npx, npx, npx, onPath, npx, npx])
  // The project's own install wins over everything.
  const own = projectInstall(dir, VERSION)
  for (const answer of answers(dir)) assert.deepEqual(answer, { command: own, args: [], how: 'project' })
  // Windows names npx.cmd, as reach "local" and "global" do.
  const win = launcher.resolveShapewallCommand({ projectDir: root, version: VERSION, env: { Path: '' }, platform: 'win32' })
  assert.equal(win.command, 'npx.cmd')
  assert.deepEqual(win, sourceAnswer(root, { Path: '' }, 'win32'))
})

test('skipPathDir is the same rule in the launcher and src/shapewall-command.js, for every reach', () => {
  const { root, dir } = box('launcher-skip')
  // A symbolic link that looks harmless but points into an npx cache and into the project.
  const npxReal = path.join(root, 'home', '.npm', '_npx', 'abc', 'node_modules', '.bin')
  fs.mkdirSync(npxReal, { recursive: true })
  const npxLink = path.join(root, 'tools-a')
  fs.symlinkSync(npxReal, npxLink)
  fs.mkdirSync(path.join(dir, 'bin'))
  const projectLink = path.join(root, 'tools-b')
  fs.symlinkSync(path.join(dir, 'bin'), projectLink)
  const posix = [
    { dir: path.join(root, 'prefix', 'bin'), skip: { local: false, global: false } },
    { dir: npxReal, skip: { local: true, global: true } },
    { dir: npxLink, skip: { local: true, global: true } },
    { dir: path.join(dir, 'node_modules', '.bin'), skip: { local: false, global: true } },
    { dir: path.join(root, 'node_modules', '.bin'), skip: { local: false, global: true } },
    { dir: path.join(root, 'other', 'node_modules', 'shapewall', 'bin'), skip: { local: false, global: true } },
    { dir: path.join(dir, 'bin'), skip: { local: false, global: true } },
    { dir: projectLink, skip: { local: false, global: true } },
    { dir, skip: { local: false, global: true } },
    { dir: `${dir}-sibling`, skip: { local: false, global: false } },
  ]
  const windows = [
    { dir: 'C:\\Users\\me\\AppData\\Roaming\\npm', skip: { local: false, global: false } },
    { dir: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin', skip: { local: true, global: true } },
    { dir: 'C:\\Work\\App\\NODE_MODULES\\.bin', skip: { local: false, global: true } },
    { dir: 'c:\\work\\app\\tools', skip: { local: false, global: true } },
    { dir: 'C:\\Work\\App-2\\tools', skip: { local: false, global: false } },
  ]
  const check = (rows, platform, projectDir) => {
    for (const row of rows) {
      for (const reach of ['local', 'project', 'global']) {
        const options = { reach, projectDir, platform }
        const ours = launcher.skipPathDir(row.dir, options)
        assert.equal(ours, source.skipPathDir(row.dir, options), `${platform} ${reach} ${row.dir}`)
        const want = reach === 'global' ? row.skip.global : row.skip.local
        assert.equal(ours, want, `${platform} ${reach} ${row.dir}`)
      }
    }
  }
  check(posix, 'linux', dir)
  check(windows, 'win32', 'C:\\Work\\App')
  assert.equal(launcher.PATH_REACH, 'global')
})

test('PATH as npm exec builds it: node_modules/.bin, _npx caches and the project folder are not "on PATH"', () => {
  const { root, dir } = box('launcher-npm-exec')
  const real = globalInstall(root, 'real', '99.0.0')
  // npm exec / npm run: the project's and its ancestors' node_modules/.bin first.
  const ancestorBin = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(ancestorBin, { recursive: true })
  const placed = globalInstall(root, 'placed', '99.0.0')
  fs.symlinkSync(path.join(placed, 'shapewall'), path.join(ancestorBin, 'shapewall'))
  // An npx cache: ~/.npm/_npx/<hash>/node_modules/.bin.
  const npxBin = path.join(root, 'home', '.npm', '_npx', 'abc123', 'node_modules', '.bin')
  fs.mkdirSync(npxBin, { recursive: true })
  fs.symlinkSync(path.join(placed, 'shapewall'), path.join(npxBin, 'shapewall'))
  // A folder inside the project with a shapewall in it.
  const inside = path.join(dir, 'tools')
  fs.mkdirSync(inside)
  fs.symlinkSync(path.join(placed, 'shapewall'), path.join(inside, 'shapewall'))
  const env = { PATH: [path.join(dir, 'node_modules', '.bin'), ancestorBin, npxBin, inside, real].join(':') }
  const chosen = launcher.resolveShapewallCommand({ projectDir: dir, version: VERSION, env, platform: 'linux' })
  assert.deepEqual(pick(chosen), { command: path.join(real, 'shapewall'), args: [], how: 'path' })
  const skip = (folder) => launcher.skipPathDir(folder, { reach: launcher.PATH_REACH, projectDir: dir, platform: 'linux' })
  assert.equal(skip(ancestorBin), true)
  assert.equal(skip(npxBin), true)
  assert.equal(skip(inside), true)
  assert.equal(skip(real), false)
  // With only npm-placed folders, the pinned npx.
  const only = { PATH: [ancestorBin, npxBin, inside].join(':') }
  assert.equal(launcher.resolveShapewallCommand({ projectDir: dir, version: VERSION, env: only, platform: 'linux' }).how, 'npx')
})

test('the project folder: CLAUDE_PROJECT_DIR, else the start folder, then up to the nearest config', () => {
  const { root, dir } = box('launcher-project')
  const sub = path.join(dir, 'src', 'deep')
  fs.mkdirSync(sub, { recursive: true })
  assert.equal(launcher.projectDirOf({}, sub), dir)
  assert.equal(launcher.projectDirOf({ CLAUDE_PROJECT_DIR: sub }, root), dir)
  // A relative or missing CLAUDE_PROJECT_DIR is ignored.
  assert.equal(launcher.projectDirOf({ CLAUDE_PROJECT_DIR: 'src' }, sub), dir)
  assert.equal(launcher.projectDirOf({ CLAUDE_PROJECT_DIR: path.join(root, 'gone') }, sub), dir)
  // No config up to the repository root: the start folder (shapewall mcp then says to run init).
  fs.rmSync(path.join(dir, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'app'))
  fs.writeFileSync(path.join(root, 'shapewall.config.json'), '{}')
  assert.equal(launcher.projectDirOf({}, path.join(repo, 'app')), path.join(repo, 'app'))
  // Never the home folder or above, even with a config there.
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, 'work'), { recursive: true })
  fs.writeFileSync(path.join(home, 'shapewall.config.json'), '{}')
  assert.equal(launcher.projectDirOf({}, path.join(home, 'work'), home), path.join(home, 'work'))
  // ...unless the app was opened in the home folder itself.
  assert.equal(launcher.projectDirOf({}, home, home), home)
})

test('SHAPEWALL_REMOTE: empty is local, a plain http(s) URL is --remote, anything else is refused', () => {
  assert.equal(launcher.remoteUrl({}), '')
  assert.equal(launcher.remoteUrl({ SHAPEWALL_REMOTE: '  ' }), '')
  assert.equal(launcher.remoteUrl({ SHAPEWALL_REMOTE: 'https://board.example.ts.net' }), 'https://board.example.ts.net')
  assert.throws(() => launcher.remoteUrl({ SHAPEWALL_REMOTE: 'file:///etc/passwd' }), /http/)
  assert.throws(() => launcher.remoteUrl({ SHAPEWALL_REMOTE: 'not a url' }), /not a URL/)
  assert.throws(() => launcher.remoteUrl({ SHAPEWALL_REMOTE: 'https://me:secret@board.example' }), /user name/)
  assert.throws(() => launcher.remoteUrl({ SHAPEWALL_REMOTE: 'https://board.example/&calc' }), /characters/)
  const { root, dir } = box('launcher-plan')
  const env = { PATH: globalInstall(root, 'g', '99.0.0'), SHAPEWALL_REMOTE: 'https://board.example' }
  const chosen = launcher.plan({ env, cwd: dir, platform: 'linux' })
  assert.deepEqual(chosen.args, ['mcp', '--remote', 'https://board.example'])
  assert.equal(chosen.cwd, dir)
  assert.deepEqual(launcher.plan({ env: { PATH: env.PATH }, cwd: dir, platform: 'linux' }).args, ['mcp'])
})

function runLauncher(args, { cwd, env }) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 })
}

test('the launcher process starts shapewall mcp in the project folder and passes its exit code', () => {
  const { root, dir } = box('launcher-run')
  const sub = path.join(dir, 'sub')
  fs.mkdirSync(sub)
  const bin = globalInstall(root, 'g', '99.0.0')
  const env = { PATH: bin, HOME: root }
  const printed = runLauncher(['--print'], { cwd: sub, env })
  assert.equal(printed.status, 0, printed.stderr)
  assert.equal(JSON.parse(printed.stdout).how, 'path')
  const ran = runLauncher([], { cwd: sub, env: { ...env, SHAPEWALL_REMOTE: 'https://board.example' } })
  assert.equal(ran.status, 0, ran.stderr)
  const seen = JSON.parse(ran.stdout)
  assert.deepEqual(seen.argv, ['mcp', '--remote', 'https://board.example'])
  // What it starts is marked as an agent's process (src/agent-run.js).
  assert.equal(seen.agentRun, '1')
  assert.equal(seen.agentHeader, 'X-Shapewall-Agent: 1')
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir))
  assert.match(ran.stderr, /starting shapewall 99\.0\.0 on PATH for https:\/\/board\.example/)
  assert.equal(runLauncher([], { cwd: dir, env: { ...env, FAKE_EXIT: '3' } }).status, 3)
  const refused = runLauncher([], { cwd: dir, env: { ...env, SHAPEWALL_REMOTE: 'ftp://x' } })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /http/)
})

// ---- 1.3.0 review: the project tier is a real npm install only

// The copied functions are the same text in both files.
test('the launcher copies the resolver functions from src/shapewall-command.js as they are', () => {
  const src = fs.readFileSync('src/shapewall-command.js', 'utf8')
  const ours = fs.readFileSync(LAUNCHER, 'utf8')
  const body = (text, name) => {
    const at = text.indexOf(`export function ${name}(`)
    return at === -1 ? null : text.slice(at, text.indexOf('\n}\n', at) + 2)
  }
  for (const name of [
    'parseVersion',
    'compareVersions',
    'packageVersionOf',
    'packageEntry',
    'gitProgram',
    'gitTracks',
    'inGitRepo',
    'projectInstall',
    'skipPathDir',
    'pathInstall',
    'directCommand',
  ]) {
    assert.ok(body(src, name), name)
    assert.equal(body(ours, name), body(src, name), name)
  }
  for (const name of ['cmdSafe', 'cmdLine']) {
    const line = (text) => text.split('\n').find((row) => row.startsWith(`export const ${name} =`))
    assert.ok(line(src), name)
    assert.equal(line(ours), line(src), name)
  }
})

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

// A cloned repository that commits node_modules with a fake shapewall bin in it.
function committedFake(name, { version = VERSION } = {}) {
  const { root, dir } = box(name)
  fs.rmSync(path.join(dir, '.git'), { recursive: true })
  git(dir, 'init', '-q')
  const bin = projectInstall(dir, version)
  fs.writeFileSync(path.join(dir, 'node_modules', 'shapewall', 'bin', 'shapewall.js'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
  git(dir, 'add', '-f', 'node_modules', 'shapewall.config.json')
  git(dir, 'commit', '-q', '-m', 'commit node_modules')
  return { root, dir, bin }
}

test('a committed node_modules/.bin/shapewall is never the project install, in the launcher or src', () => {
  const { root, dir, bin } = committedFake('launcher-committed')
  const global = globalInstall(root, 'g', '99.0.0')
  for (const module of [launcher, source]) {
    const own = module.projectInstall(dir, { platform: 'linux', version: VERSION })
    assert.equal(own.bin, bin)
    assert.match(own.refused, /committed/)
  }
  const chosen = launcher.resolveShapewallCommand({ projectDir: dir, version: VERSION, env: { PATH: global }, platform: 'linux' })
  assert.deepEqual(pick(chosen), { command: path.join(global, 'shapewall'), args: [], how: 'path' })
  assert.match(chosen.note, /passed over: it is committed/)
  const npx = launcher.resolveShapewallCommand({ projectDir: dir, version: VERSION, env: { PATH: '' }, platform: 'linux' })
  assert.equal(npx.how, 'npx')
  const local = source.resolveShapewallCommand({ projectDir: dir, version: VERSION, reach: 'local', env: { PATH: '' }, platform: 'linux' })
  assert.equal(local.how, 'npx')
  // The launcher process itself never runs the planted bin.
  const printed = runLauncher(['--print'], { cwd: dir, env: { PATH: `${global}:${process.env.PATH}`, HOME: root } })
  assert.equal(printed.status, 0, printed.stderr)
  assert.equal(JSON.parse(printed.stdout).how, 'path')
  // The same files, installed and not committed, are the project install.
  git(dir, 'rm', '-r', '-q', '--cached', 'node_modules')
  git(dir, 'commit', '-q', '-m', 'untrack node_modules')
  assert.equal(launcher.projectInstall(dir, { platform: 'linux', version: VERSION }).bin, bin)
  assert.equal(launcher.projectInstall(dir, { platform: 'linux', version: VERSION }).refused, undefined)
})

test('the project install must be the package bin, shapewall at or above the pinned version, and yours', () => {
  const { dir } = box('launcher-real-install')
  const untracked = () => false
  const check = (options = {}) => launcher.projectInstall(dir, { platform: 'linux', version: VERSION, tracked: untracked, ...options })
  assert.equal(check(), null)
  const bin = projectInstall(dir, '0.9.0')
  assert.match(check().refused, /older than/)
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
  projectInstall(dir, VERSION)
  assert.equal(check().version, VERSION)
  assert.match(check({ uid: process.getuid() + 1 }).refused, /another user/)
  // A plain script in .bin, not a link to the package's bin file.
  fs.rmSync(bin)
  fs.writeFileSync(bin, '#!/bin/sh\necho planted\n', { mode: 0o755 })
  assert.match(check().refused, /not the package's own bin/)
  // A link out of node_modules/shapewall.
  fs.rmSync(bin)
  fs.writeFileSync(path.join(dir, 'planted.js'), '#!/bin/sh\n', { mode: 0o755 })
  fs.symlinkSync('../../planted.js', bin)
  assert.match(check().refused, /not the package's own bin/)
  // A package.json that is not shapewall's, or names a bin outside the package.
  fs.rmSync(bin)
  fs.symlinkSync('../shapewall/bin/shapewall.js', bin)
  const pkg = path.join(dir, 'node_modules', 'shapewall', 'package.json')
  fs.writeFileSync(pkg, JSON.stringify({ name: 'other', version: VERSION }))
  assert.match(check().refused, /no shapewall package.json/)
  fs.writeFileSync(pkg, JSON.stringify({ name: 'shapewall', version: VERSION, bin: '../../planted.js' }))
  assert.match(check().refused, /names no bin file/)
})

test('when git cannot say, only a folder outside any repository counts as untracked', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-launcher-nogit-'))
  try {
    projectInstall(outside, VERSION)
    const options = { platform: 'linux', version: VERSION, tracked: () => null }
    assert.equal(launcher.inGitRepo(outside), false)
    assert.equal(launcher.projectInstall(outside, options).refused, undefined)
    fs.mkdirSync(path.join(outside, '.git'))
    assert.match(launcher.projectInstall(outside, options).refused, /git could not say/)
    // No git on PATH reads as "cannot say".
    assert.equal(launcher.gitTracks(outside, ['node_modules'], { env: { PATH: '' } }), null)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('git for the check comes from an absolute PATH folder outside the project, run without a shell', () => {
  const { root, dir } = box('launcher-git')
  const planted = path.join(dir, 'tools')
  fs.mkdirSync(planted)
  fs.writeFileSync(path.join(planted, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const real = path.join(root, 'realgit')
  fs.mkdirSync(real)
  fs.writeFileSync(path.join(real, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const env = { PATH: `.:tools:${planted}:${real}` }
  assert.equal(launcher.gitProgram(dir, env, 'linux'), path.join(real, 'git'))
  const calls = []
  const run = (file, args, options) => {
    calls.push({ file, args, options })
    throw Object.assign(new Error('no match'), { status: 1 })
  }
  assert.equal(launcher.gitTracks(dir, ['node_modules/.bin/shapewall'], { env, run }), false)
  assert.equal(calls[0].file, path.join(real, 'git'))
  assert.deepEqual(calls[0].args.slice(-6), ['-C', dir, 'ls-files', '--error-unmatch', '--', 'node_modules/.bin/shapewall'])
  assert.equal(calls[0].options.shell, false)
  assert.ok(calls[0].options.timeout > 0)
  assert.equal(calls[0].options.cwd, os.tmpdir())
  // Any other failure (not a repository, a timeout) is "cannot say".
  assert.equal(
    launcher.gitTracks(dir, ['x'], {
      env,
      run: () => {
        throw Object.assign(new Error('x'), { status: 128 })
      },
    }),
    null,
  )
})

// ---- the start folder walk

test('the project folder: no walk outside a repository, never to the file system root, never a folder of another user', () => {
  const { root } = box('launcher-walk')
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  // No .git anywhere up to home: only the start folder, even with a config above it.
  const plain = path.join(home, 'plain', 'sub')
  fs.mkdirSync(plain, { recursive: true })
  fs.writeFileSync(path.join(home, 'plain', 'shapewall.config.json'), '{}')
  assert.equal(launcher.projectDirOf({}, plain, home), plain)
  // Inside a repository: up to its root, not past it.
  const repo = path.join(home, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'shapewall.config.json'), '{}')
  assert.equal(launcher.projectDirOf({}, path.join(repo, 'a', 'b'), home), repo)
  // A config folder that is not the current user's is never used.
  assert.equal(launcher.projectDirOf({}, path.join(repo, 'a', 'b'), home, { uid: process.getuid() + 1 }), path.join(repo, 'a', 'b'))
  // Outside home without a .git: only the start folder (a config in a parent such as /tmp is never used).
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-launcher-walk-'))
  try {
    const deep = path.join(outside, 'x', 'y')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(outside, 'shapewall.config.json'), '{}')
    assert.equal(launcher.projectDirOf({}, deep, home), deep)
    assert.equal(launcher.projectDirOf({}, outside, home), outside)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

// ---- Windows: no shell for a path

test('Windows: shims start as node and the package bin, npx as npx-cli.js, cmd.exe only for plain text', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe'
  const npxCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js'
  const entries = {
    'C:\\Users\\A & B\\AppData\\Roaming\\npm\\node_modules\\shapewall':
      'C:\\Users\\A & B\\AppData\\Roaming\\npm\\node_modules\\shapewall\\bin\\shapewall.js',
    'C:\\Work\\My App\\node_modules\\shapewall': 'C:\\Work\\My App\\node_modules\\shapewall\\bin\\shapewall.js',
  }
  const options = { platform: 'win32', execPath: node, exists: (file) => file === npxCli, entryOf: (dir) => entries[dir] || null }
  for (const module of [launcher, source]) {
    const run = (command, args, extra = {}) => module.directCommand(command, args, { ...options, ...extra })
    assert.deepEqual(run('npx.cmd', ['-y', 'shapewall@1.3.0', 'mcp']), {
      command: node,
      args: [npxCli, '-y', 'shapewall@1.3.0', 'mcp'],
      shell: false,
    })
    assert.deepEqual(run('C:\\Users\\A & B\\AppData\\Roaming\\npm\\shapewall.cmd', ['mcp']), {
      command: node,
      args: [entries['C:\\Users\\A & B\\AppData\\Roaming\\npm\\node_modules\\shapewall'], 'mcp'],
      shell: false,
    })
    assert.deepEqual(run('C:\\Work\\My App\\node_modules\\.bin\\shapewall.cmd', ['mcp']), {
      command: node,
      args: [entries['C:\\Work\\My App\\node_modules\\shapewall'], 'mcp'],
      shell: false,
    })
    // An .exe starts as it is; so does everything on other systems.
    assert.deepEqual(run('C:\\x\\shapewall.exe', ['mcp']), { command: 'C:\\x\\shapewall.exe', args: ['mcp'], shell: false })
    assert.deepEqual(module.directCommand('/usr/bin/npx', ['-y'], { platform: 'linux' }), {
      command: '/usr/bin/npx',
      args: ['-y'],
      shell: false,
    })
    // No npx-cli.js beside node: npx.cmd through cmd.exe, only as plain text.
    const bare = run('npx.cmd', ['-y', 'shapewall@1.3.0', 'mcp'], { exists: () => false })
    assert.deepEqual(bare, { command: 'npx.cmd', args: ['-y', 'shapewall@1.3.0', 'mcp'], shell: true })
    assert.equal(module.cmdLine([bare.command, ...bare.args, 'a b']), 'npx.cmd -y shapewall@1.3.0 mcp "a b"')
    for (const bad of ['a&calc', '50%', 'x^y', 'a|b', 'a"b', 'a>b', 'a<b', 'a!b']) {
      assert.throws(() => run('npx.cmd', ['mcp', '--config', bad], { exists: () => false }), /safely on Windows/, bad)
    }
    // A shim whose package cannot be found, in a folder with a space: refused, never a shell.
    assert.throws(() => run('C:\\Program Files\\tools\\shapewall.cmd', ['mcp']), /safely on Windows/)
    assert.equal(module.cmdSafe(['C:\\tools\\x.cmd', 'a b']), true)
    assert.equal(module.cmdSafe(['C:\\my tools\\x.cmd']), false)
  }
})
