// The plugin's MCP launcher (plugins/shapewall/bin/shapewall-mcp.mjs): its
// copy of the command resolver gives the same answers as
// src/shapewall-command.js (reach "local") on the same table, it skips the
// PATH folders npm puts first for one project or one npx run, it finds the
// project folder, and it starts `shapewall mcp` (or `mcp --remote URL`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
    `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))\nprocess.exit(Number(process.env.FAKE_EXIT || 0))\n`,
    { mode: 0o755 },
  )
  const bin = path.join(root, `${name}-bin`)
  fs.mkdirSync(bin)
  fs.symlinkSync(path.join(pkg, 'bin', 'shapewall.js'), path.join(bin, 'shapewall'))
  return bin
}

function projectInstall(dir, version) {
  const own = path.join(dir, 'node_modules')
  fs.mkdirSync(path.join(own, '.bin'), { recursive: true })
  fs.mkdirSync(path.join(own, 'shapewall'), { recursive: true })
  fs.writeFileSync(path.join(own, 'shapewall', 'package.json'), JSON.stringify({ name: 'shapewall', version }))
  fs.writeFileSync(path.join(own, '.bin', 'shapewall'), '#!/bin/sh\n', { mode: 0o755 })
  return path.join(own, '.bin', 'shapewall')
}

function box(name) {
  const root = tempDir(name)
  const dir = path.join(root, 'project')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), '{}')
  return { root, dir }
}

const pick = ({ command, args, how }) => ({ command, args, how })

test('the launcher pins the package version', () => {
  assert.equal(launcher.PINNED, VERSION)
})

test('the launcher resolver answers the shared table like src/shapewall-command.js', () => {
  const { root, dir } = box('launcher-table')
  const newer = globalInstall(root, 'new', '99.0.0')
  const older = globalInstall(root, 'old', '0.9.0')
  const empty = path.join(root, 'nothing')
  const rows = [
    { name: 'PATH at or above this version', env: { PATH: newer } },
    { name: 'PATH older', env: { PATH: older } },
    { name: 'older first, newer after', env: { PATH: `${older}:${newer}` } },
    { name: 'no shapewall anywhere', env: { PATH: empty } },
    { name: 'relative PATH entries', env: { PATH: `.:bin:${newer}` } },
  ]
  const answers = (projectDir) =>
    rows.map((row) => {
      const ours = launcher.resolveShapewallCommand({ projectDir, version: VERSION, env: row.env, platform: 'linux' })
      const theirs = source.resolveShapewallCommand({ projectDir, version: VERSION, reach: 'local', env: row.env, platform: 'linux' })
      assert.deepEqual(ours, theirs, row.name)
      return pick(ours)
    })
  // Without a project install: PATH when new enough, else the pinned npx.
  const npx = { command: 'npx', args: ['-y', `shapewall@${VERSION}`], how: 'npx' }
  assert.deepEqual(answers(dir), [
    { command: path.join(newer, 'shapewall'), args: [], how: 'path' },
    npx,
    npx,
    npx,
    { command: path.join(newer, 'shapewall'), args: [], how: 'path' },
  ])
  // The project's own install wins over everything.
  const own = projectInstall(dir, '1.0.0')
  for (const answer of answers(dir)) assert.deepEqual(answer, { command: own, args: [], how: 'project' })
  // Windows names npx.cmd.
  assert.equal(launcher.resolveShapewallCommand({ projectDir: root, env: { Path: '' }, platform: 'win32' }).command, 'npx.cmd')
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
  assert.equal(launcher.npmPlacedDir(ancestorBin), true)
  assert.equal(launcher.npmPlacedDir(npxBin), true)
  assert.equal(launcher.npmPlacedDir(inside, dir), true)
  assert.equal(launcher.npmPlacedDir(real, dir), false)
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
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir))
  assert.match(ran.stderr, /starting shapewall 99\.0\.0 on PATH for https:\/\/board\.example/)
  assert.equal(runLauncher([], { cwd: dir, env: { ...env, FAKE_EXIT: '3' } }).status, 3)
  const refused = runLauncher([], { cwd: dir, env: { ...env, SHAPEWALL_REMOTE: 'ftp://x' } })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /http/)
})
