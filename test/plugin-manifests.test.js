// The Claude Code and Codex plugin (plugins/shapewall) and the two
// marketplaces at the repository root: generated files are current, versions
// equal the package's, skills parse, and the copy follows the project's
// rules. `claude plugin validate --strict` is run by hand (docs/plugins.md);
// this test needs neither CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { staleFiles, codexBootstrap, PLUGIN, SKILLS } from '../scripts/build-plugin-skills.mjs'
import { LOOP_SUMMARY, UNTRUSTED_TEXT } from '../src/mcp-instructions.js'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).flatMap((entry) => {
    const file = path.join(entry.parentPath ?? entry.path, entry.name)
    return entry.isFile() ? [file] : []
  })
}

const TEXT_FILES = [
  ...filesUnder(PLUGIN).filter((file) => !file.endsWith('.png')),
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  'scripts/build-plugin-skills.mjs',
  'docs/plugins.md',
]

test('generated plugin files are current (node scripts/build-plugin-skills.mjs)', () => {
  assert.deepEqual(staleFiles(), [])
})

test('both plugin manifests, the launcher and the Codex server entry carry the package version', () => {
  const claude = json(`${PLUGIN}/.claude-plugin/plugin.json`)
  const codex = json(`${PLUGIN}/.codex-plugin/plugin.json`)
  assert.equal(claude.version, pkg.version)
  assert.equal(codex.version, pkg.version)
  assert.equal(claude.name, 'shapewall')
  assert.equal(codex.name, 'shapewall')
  assert.match(
    fs.readFileSync(`${PLUGIN}/bin/shapewall-mcp.mjs`, 'utf8'),
    new RegExp(`^export const PINNED = '${pkg.version.replace(/\./g, '\\.')}'$`, 'm'),
  )
  const server = json(`${PLUGIN}/.mcp.json`).mcpServers.shapewall
  assert.deepEqual(server.args, ['-e', codexBootstrap(pkg.version)])
  assert.ok(server.args[1].includes(`'${pkg.version}','bin','shapewall-mcp.mjs'`))
})

test('Claude Code runs the launcher from the plugin root; Codex reads the root .mcp.json; no token anywhere', () => {
  const claude = json(`${PLUGIN}/.claude-plugin/plugin.json`)
  const codex = json(`${PLUGIN}/.codex-plugin/plugin.json`)
  // The same server name, so Claude Code's inline entry replaces the root .mcp.json it also loads.
  assert.deepEqual(Object.keys(claude.mcpServers), ['shapewall'])
  assert.deepEqual(Object.keys(json(`${PLUGIN}/.mcp.json`).mcpServers), ['shapewall'])
  const inline = claude.mcpServers.shapewall
  assert.equal(inline.command, 'node')
  assert.deepEqual(inline.args, ['${CLAUDE_PLUGIN_ROOT}/bin/shapewall-mcp.mjs'])
  assert.deepEqual(inline.env, { SHAPEWALL_REMOTE: '${user_config.remote_url}' })
  assert.equal(claude.userConfig.remote_url.default, '')
  assert.equal(claude.userConfig.remote_url.sensitive, undefined)
  assert.equal(codex.mcpServers, './.mcp.json')
  assert.equal(codex.skills, './skills/')
  for (const file of TEXT_FILES.filter((file) => file.endsWith('.json')))
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /token|secret|password|api[_-]?key/i, file)
})

test('marketplaces point at ./plugins/shapewall; plugins ship from git, not npm', () => {
  const claude = json('.claude-plugin/marketplace.json')
  assert.equal(claude.name, 'shapewall')
  assert.ok(claude.owner?.name)
  assert.deepEqual(
    claude.plugins.map((plugin) => [plugin.name, plugin.source]),
    [['shapewall', './plugins/shapewall']],
  )
  const codex = json('.agents/plugins/marketplace.json')
  assert.equal(codex.name, 'shapewall')
  assert.deepEqual(codex.plugins[0].source, { source: 'local', path: './plugins/shapewall' })
  assert.equal(codex.plugins[0].policy.installation, 'AVAILABLE')
  assert.ok(!pkg.files.some((entry) => entry.startsWith('plugins') || entry.startsWith('.claude-plugin') || entry.startsWith('.agents')))
})

test('skills: frontmatter parses, names are kebab-case and match their folder, model invocation stays on for Codex', () => {
  const dirs = fs.readdirSync(`${PLUGIN}/skills`).sort()
  assert.deepEqual(dirs, Object.keys(SKILLS).sort())
  for (const dir of dirs) {
    const text = fs.readFileSync(`${PLUGIN}/skills/${dir}/SKILL.md`, 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
    assert.ok(match, `${dir}: frontmatter`)
    const fields = Object.fromEntries(
      match[1].split('\n').map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at), line.slice(at + 1).trim()]
      }),
    )
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'name'], dir)
    assert.equal(fields.name, dir)
    assert.match(fields.name, KEBAB)
    const description = JSON.parse(fields.description)
    assert.ok(description.length > 40 && description.length < 400, `${dir}: description length`)
    assert.match(description, /Use when/)
  }
  const main = fs.readFileSync(`${PLUGIN}/skills/shapewall/SKILL.md`, 'utf8')
  for (const line of LOOP_SUMMARY) assert.ok(main.includes(line), 'the loop comes from src/mcp-instructions.js')
  for (const dir of ['shapewall', 'shapewall-next', 'shapewall-status'])
    assert.ok(fs.readFileSync(`${PLUGIN}/skills/${dir}/SKILL.md`, 'utf8').includes(UNTRUSTED_TEXT), `${dir}: untrusted text rule`)
})

test('plugin copy: no absolute paths, no em or en dashes, never a feedback or review tool', () => {
  for (const file of TEXT_FILES) {
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /[–—]/, `${file}: em or en dash`)
    assert.doesNotMatch(text, /(feedback|review)[ -]tool/i, `${file}: positioning`)
    if (file.startsWith(PLUGIN) || file.endsWith('marketplace.json'))
      assert.doesNotMatch(text, /\/home\/|\/Users\/|[A-Z]:\\\\/, `${file}: absolute path`)
  }
})
