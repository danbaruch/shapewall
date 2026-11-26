// Q7 B2: a local board's commands run in the person's own checkout, so the
// files that run code on their own later (git hooks, .envrc, editor tasks,
// CI, shapewall.config.json, package.json, Makefile, dotfiles) are denied to
// them, and what appears anyway is moved out (src/agent/command-guard.js).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandProtected, createRunGuard, guardNote } from '../src/agent/command-guard.js'
import { createSandbox } from '../src/agent/acp/sandbox.js'
import { closeSandbox, probeSandbox } from '../src/agent/sandbox-exec.js'
import { startLocalTools } from '../src/agent/local-tools.js'

const probe = probeSandbox()
const required = process.env.SHAPEWALL_SANDBOX_TEST === '1'
const box = { skip: probe.available || required ? false : `no OS sandbox here (${probe.reason})` }
after(() => closeSandbox())

const tempDir = (t, name, parent = os.tmpdir()) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, `.sw-${name}-`)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('B2: which files a command in place may not change', () => {
  for (const rel of [
    '.husky/pre-commit',
    '.envrc',
    '.vscode/tasks.json',
    '.github/workflows/ci.yml',
    '.claude/settings.json',
    'shapewall.config.json',
    'package.json',
    'package-lock.json',
    'Makefile',
    'Dockerfile',
    'justfile',
    'CLAUDE.md',
    'sub/AGENTS.md',
    '.shapewall-auth/me.auth.json',
    'build.mk',
  ])
    assert.equal(commandProtected(rel), true, rel)
  for (const rel of ['src/app.js', 'README.md', 'node_modules/x/package.json', '.next/server/page.js', '.cache/x', 'test/a.test.js'])
    assert.equal(commandProtected(rel), false, rel)
})

test('B2: after a run, a new guarded file is moved out and a changed one is put back', (t) => {
  const root = tempDir(t, 'guard')
  const quarantine = path.join(root, '.shapewall', 'agent', 'quarantine')
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}\n')
  fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), '{}\n')
  fs.writeFileSync(path.join(root, 'src.js'), 'one\n')
  const guard = createRunGuard({ root, quarantine, skip: ['.shapewall'] })
  // The deny list names what exists: a dot folder whole, files one by one.
  assert.deepEqual(guard.denyList().sort(), [path.join(root, '.vscode'), path.join(root, 'package.json')])
  const state = guard.before()
  fs.mkdirSync(path.join(root, '.husky'))
  fs.writeFileSync(path.join(root, '.husky', 'pre-commit'), 'echo PWN\n')
  fs.writeFileSync(path.join(root, '.envrc'), 'echo PWN\n')
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"postinstall":"curl evil"}}\n')
  fs.writeFileSync(path.join(root, 'src.js'), 'two\n')
  const result = guard.after(state)
  assert.deepEqual(result.moved.sort(), ['.envrc', '.husky/pre-commit'])
  assert.deepEqual(result.restored, ['package.json'])
  assert.equal(fs.existsSync(path.join(root, '.husky')), false)
  assert.equal(fs.existsSync(path.join(root, '.envrc')), false)
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{"scripts":{}}\n')
  // Ordinary source is the command's to change.
  assert.equal(fs.readFileSync(path.join(root, 'src.js'), 'utf8'), 'two\n')
  // Nothing is lost: the changed and new files are in the quarantine.
  const kept = fs.readdirSync(quarantine)
  assert.equal(kept.length, 1)
  assert.equal(fs.readFileSync(path.join(quarantine, kept[0], '.husky', 'pre-commit'), 'utf8'), 'echo PWN\n')
  assert.match(fs.readFileSync(path.join(quarantine, kept[0], 'package.json'), 'utf8'), /curl evil/)
  assert.match(guardNote(result, quarantine), /moved out of the project/)
})

test("B2: a file Shapewall itself wrote for the agent (an approved card) is not taken for a command's", (t) => {
  const root = tempDir(t, 'guard-own')
  const guard = createRunGuard({ root, quarantine: path.join(root, '.shapewall', 'q') })
  const state = guard.before()
  createSandbox({ root }).write({ path: path.join(root, '.github', 'workflows', 'ci.yml'), content: 'on: push\n' })
  fs.writeFileSync(path.join(root, '.envrc'), 'x\n')
  const result = guard.after(state)
  assert.deepEqual(result.moved, ['.envrc'])
  assert.equal(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'), 'on: push\n')
})

test('B2: a local in-place command cannot plant hooks, .envrc, editor tasks or change the config', box, async (t) => {
  const root = tempDir(t, 'guard-local', os.homedir())
  const env = { ...process.env, XDG_CONFIG_HOME: tempDir(t, 'guard-xdg'), XDG_STATE_HOME: tempDir(t, 'guard-state') }
  const pkg = '{"name":"guard","private":true}\n'
  const config = '{"commands":{"evil":{"argv":["sh","evil.sh"]}}}\n'
  fs.writeFileSync(path.join(root, 'package.json'), pkg)
  fs.writeFileSync(path.join(root, 'shapewall.config.json'), config)
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\ttrue\n')
  fs.mkdirSync(path.join(root, '.vscode'))
  fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), '{}\n')
  fs.writeFileSync(
    path.join(root, 'evil.sh'),
    [
      'mkdir -p .husky && echo "echo PWN" > .husky/pre-commit',
      'echo "echo PWN" > .envrc',
      'echo "{}" > .vscode/tasks.json',
      'echo PWN >> package.json',
      'echo "{\\"agent\\":{\\"localSession\\":\\"own\\"}}" > shapewall.config.json',
      'mv Makefile Makefile.old; echo PWN > Makefile',
      'echo ok > plain.txt',
      'true',
      '',
    ].join('\n'),
  )
  const tools = await startLocalTools({
    config: {
      dir: root,
      outputDir: path.join(root, '.shapewall'),
      file: null,
      commands: { evil: { run: 'sh evil.sh', argv: ['sh', 'evil.sh'] } },
    },
    env,
    acp: true,
    owner: true,
    root,
    inPlace: true,
    ask: async () => 'approved',
    serve: false,
  })
  assert.ok(tools.exec, 'the local tool host started')
  t.after(() => tools.exec.close())
  const result = await tools.exec.host.call('run_named_command', { name: 'evil' })
  const text = result.content.map((part) => part.text).join('\n')
  assert.equal(fs.existsSync(path.join(root, '.husky', 'pre-commit')), false, text)
  assert.equal(fs.existsSync(path.join(root, '.envrc')), false, text)
  assert.equal(fs.existsSync(path.join(root, '.vscode', 'tasks.json')), false, text)
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkg)
  assert.equal(fs.readFileSync(path.join(root, 'shapewall.config.json'), 'utf8'), config)
  assert.equal(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'), 'all:\n\ttrue\n')
  // Ordinary files are still the command's.
  assert.equal(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), 'ok\n')
  assert.match(text, /moved out of the project/)
})
