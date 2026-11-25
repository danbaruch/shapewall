// The Shapewall section in AGENTS.md / CLAUDE.md (src/agent-docs.js): where
// it goes for each combination of files, idempotence, removal, a section
// someone deleted never coming back, CRLF files, symbolic links, and the
// `init`, `agent docs` and first-run paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  END_MARKER,
  START_MARKER,
  addAgentDocsOnce,
  agentDocsBlock,
  findBlock,
  planAgentDocs,
  readState,
  removeAgentDocs,
  withBlock,
  withoutBlock,
  writeAgentDocs,
} from '../src/agent-docs.js'
import { LOOP_SUMMARY, UNTRUSTED_TEXT, mcpInstructions } from '../src/mcp-instructions.js'
import { agentDocsCommand } from '../src/cli/agent-setup-command.js'
import { init } from '../src/cli/init.js'
import { normalizeConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8')
const exists = (dir, name) => fs.existsSync(path.join(dir, name))
const project = (name) => {
  const dir = tempDir(name)
  return { dir, outputDir: path.join(dir, '.shapewall') }
}
const NO_CI = {}

test('the section: markers, the shared loop and untrusted line, nothing machine-specific', () => {
  const block = agentDocsBlock()
  assert.ok(block.startsWith(`${START_MARKER}\n`))
  assert.ok(block.endsWith(`\n${END_MARKER}`))
  for (const step of LOOP_SUMMARY) assert.ok(block.includes(step))
  assert.ok(block.includes(UNTRUSTED_TEXT))
  // The MCP servers' own instructions end with the same line.
  assert.ok(mcpInstructions().endsWith(UNTRUSTED_TEXT))
  assert.doesNotMatch(block, /localhost|127\.0\.0\.1|:\d{4}|\/home\/|swp_|token/i)
  assert.doesNotMatch(block, /[\u2013\u2014]/)
  assert.ok(block.split('\n').length <= 20)
})

test('neither file: AGENTS.md with the section and CLAUDE.md importing it', () => {
  const { dir, outputDir } = project('docs-none')
  const result = writeAgentDocs(dir, outputDir)
  assert.deepEqual(result.written, ['AGENTS.md', 'CLAUDE.md'])
  assert.equal(read(dir, 'AGENTS.md'), `${agentDocsBlock()}\n`)
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n')
  assert.deepEqual(readState(outputDir).created, ['AGENTS.md', 'CLAUDE.md'])
})

test('AGENTS.md only: the section is appended, the text before it kept, CLAUDE.md made to import it', () => {
  const { dir, outputDir } = project('docs-agents')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\n\nUse tabs.\n')
  writeAgentDocs(dir, outputDir)
  assert.equal(read(dir, 'AGENTS.md'), `# Rules\n\nUse tabs.\n\n${agentDocsBlock()}\n`)
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n')
})

test('CLAUDE.md only: the section goes there, no AGENTS.md is made', () => {
  const { dir, outputDir } = project('docs-claude')
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude rules\n')
  writeAgentDocs(dir, outputDir)
  assert.equal(read(dir, 'CLAUDE.md'), `# Claude rules\n\n${agentDocsBlock()}\n`)
  assert.equal(exists(dir, 'AGENTS.md'), false)
})

test('both files: AGENTS.md gets it; CLAUDE.md is left alone when it imports AGENTS.md, else gets its own copy', () => {
  const imports = project('docs-both-import')
  fs.writeFileSync(path.join(imports.dir, 'AGENTS.md'), '# A\n')
  fs.writeFileSync(path.join(imports.dir, 'CLAUDE.md'), '# C\n@AGENTS.md\n')
  writeAgentDocs(imports.dir, imports.outputDir)
  assert.equal(read(imports.dir, 'CLAUDE.md'), '# C\n@AGENTS.md\n')
  assert.ok(findBlock(read(imports.dir, 'AGENTS.md')))

  const apart = project('docs-both-apart')
  fs.writeFileSync(path.join(apart.dir, 'AGENTS.md'), '# A\n')
  fs.writeFileSync(path.join(apart.dir, 'CLAUDE.md'), '# C\n')
  const result = writeAgentDocs(apart.dir, apart.outputDir)
  assert.deepEqual(result.written, ['AGENTS.md', 'CLAUDE.md'])
  // Never an import of the rest of someone's AGENTS.md.
  assert.doesNotMatch(read(apart.dir, 'CLAUDE.md'), /^@AGENTS\.md$/m)
  assert.ok(findBlock(read(apart.dir, 'CLAUDE.md')))
})

test('idempotent: a second write changes nothing; an old section is replaced, not added again', () => {
  const { dir, outputDir } = project('docs-idem')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n')
  writeAgentDocs(dir, outputDir)
  const first = read(dir, 'AGENTS.md')
  const again = writeAgentDocs(dir, outputDir)
  assert.equal(again.changed, false)
  assert.equal(read(dir, 'AGENTS.md'), first)
  // An older section (other text, even another version) is replaced in place.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n\n<!-- shapewall:start v0 -->\nold words\n<!-- shapewall:end -->\n\n## After\n')
  writeAgentDocs(dir, outputDir)
  const text = read(dir, 'AGENTS.md')
  assert.equal(text, `# A\n\n${agentDocsBlock()}\n\n## After\n`)
  assert.doesNotMatch(text, /old words/)
})

test('CRLF files keep CRLF, and the text outside the markers is byte for byte the same', () => {
  const before = '# A\r\nline one\r\n'
  const text = withBlock(before, 'AGENTS.md')
  assert.ok(text.startsWith(before))
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/)
  assert.equal(withoutBlock(text, 'AGENTS.md'), before)
})

test('a broken or doubled section is refused, never guessed at', () => {
  assert.throws(() => withBlock(`${START_MARKER}\nno end\n`, 'AGENTS.md'), /no "<!-- shapewall:end -->"/)
  const twice = `${agentDocsBlock()}\n\n${agentDocsBlock()}\n`
  assert.throws(() => withBlock(twice, 'AGENTS.md'), /two Shapewall sections/)
})

test('symbolic links are never written through', () => {
  const { dir, outputDir } = project('docs-links')
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n')
  fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'))
  const plan = planAgentDocs(dir)
  // CLAUDE.md links to AGENTS.md: it already reads the section.
  assert.deepEqual(
    plan.changes.map((change) => change.name),
    ['AGENTS.md'],
  )
  assert.deepEqual(plan.notes, [])

  const other = project('docs-links-other')
  const outside = path.join(other.dir, 'elsewhere.md')
  fs.writeFileSync(outside, '# Elsewhere\n')
  fs.symlinkSync(outside, path.join(other.dir, 'AGENTS.md'))
  fs.writeFileSync(path.join(other.dir, 'CLAUDE.md'), '# C\n')
  const result = writeAgentDocs(other.dir, other.outputDir)
  assert.deepEqual(result.written, ['CLAUDE.md'])
  assert.equal(fs.readFileSync(outside, 'utf8'), '# Elsewhere\n')
  assert.match(result.notes.join(' '), /AGENTS\.md is a symbolic link/)

  const onlyLink = project('docs-links-only')
  fs.symlinkSync(outside, path.join(onlyLink.dir, 'CLAUDE.md'))
  const third = writeAgentDocs(onlyLink.dir, onlyLink.outputDir)
  assert.deepEqual(third.written, ['AGENTS.md'])
  assert.equal(fs.readFileSync(outside, 'utf8'), '# Elsewhere\n')
  void outputDir
})

test('remove: only the section goes; files Shapewall made and nobody added to are deleted', () => {
  const made = project('docs-remove-made')
  writeAgentDocs(made.dir, made.outputDir)
  const result = removeAgentDocs(made.dir, made.outputDir)
  assert.deepEqual(result.removed, ['AGENTS.md'])
  assert.deepEqual(result.deleted, ['AGENTS.md', 'CLAUDE.md'])
  assert.equal(exists(made.dir, 'AGENTS.md'), false)
  assert.equal(exists(made.dir, 'CLAUDE.md'), false)

  const mine = project('docs-remove-mine')
  fs.writeFileSync(path.join(mine.dir, 'AGENTS.md'), '# A\n\nkeep me\n')
  writeAgentDocs(mine.dir, mine.outputDir)
  removeAgentDocs(mine.dir, mine.outputDir)
  assert.equal(read(mine.dir, 'AGENTS.md'), '# A\n\nkeep me\n')
  // CLAUDE.md was made by Shapewall, but AGENTS.md (which it imports) stays: so does it.
  assert.equal(read(mine.dir, 'CLAUDE.md'), '@AGENTS.md\n')

  const added = project('docs-remove-added')
  writeAgentDocs(added.dir, added.outputDir)
  fs.appendFileSync(path.join(added.dir, 'AGENTS.md'), '\n# Mine now\n')
  removeAgentDocs(added.dir, added.outputDir)
  assert.equal(read(added.dir, 'AGENTS.md').trim(), '# Mine now')
})

const projectConfig = (dir, extra = {}) =>
  normalizeConfig(
    { title: 'T', baseUrl: 'http://localhost:3000', pages: [{ id: 'home', path: '/', title: 'Home' }], ...extra },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )

test('first serve or capture: added once, never back after a removal, off with agentDocs: false or in CI', () => {
  const { dir } = project('docs-once')
  const config = projectConfig(dir)
  assert.match(addAgentDocsOnce(config, { env: NO_CI }), /Added a Shapewall section to AGENTS\.md \(and a CLAUDE\.md that imports it\)/)
  assert.equal(addAgentDocsOnce(config, { env: NO_CI }), null)
  removeAgentDocs(dir, config.outputDir)
  assert.equal(addAgentDocsOnce(config, { env: NO_CI }), null)
  assert.equal(exists(dir, 'AGENTS.md'), false)
  // Deleted by hand without the command: the record still says it was added once.
  writeAgentDocs(dir, config.outputDir)
  fs.rmSync(path.join(dir, 'AGENTS.md'))
  assert.equal(addAgentDocsOnce(config, { env: NO_CI }), null)
  assert.equal(exists(dir, 'AGENTS.md'), false)

  const off = project('docs-once-off')
  assert.equal(addAgentDocsOnce(projectConfig(off.dir, { agentDocs: false }), { env: NO_CI }), null)
  assert.equal(exists(off.dir, 'AGENTS.md'), false)
  const ci = project('docs-once-ci')
  assert.equal(addAgentDocsOnce(projectConfig(ci.dir), { env: { CI: 'true' } }), null)
  assert.equal(exists(ci.dir, 'AGENTS.md'), false)

  // A section someone committed is remembered, not rewritten.
  const committed = project('docs-once-committed')
  fs.writeFileSync(path.join(committed.dir, 'CLAUDE.md'), `${agentDocsBlock()}\n`)
  assert.equal(addAgentDocsOnce(projectConfig(committed.dir), { env: NO_CI }), null)
  assert.ok(readState(path.join(committed.dir, '.shapewall')))
})

test('a config with agentDocs that is not a boolean is refused', () => {
  const { dir } = project('docs-config')
  assert.throws(() => projectConfig(dir, { agentDocs: 'no' }), /agentDocs: true or false/)
  assert.equal(projectConfig(dir).agentDocs, true)
})

test('init writes the section; --no-agent-docs does not', async () => {
  const fetch = async () => {
    throw new Error('no network in this test')
  }
  const on = project('docs-init')
  const lines = []
  await init(
    { config: path.join(on.dir, 'shapewall.config.json'), 'base-url': 'http://localhost:3000', 'no-discover': true },
    (line) => lines.push(line),
    {
      fetch,
    },
  )
  assert.ok(findBlock(read(on.dir, 'AGENTS.md')))
  assert.match(lines.join('\n'), /Added a Shapewall section to AGENTS\.md/)

  const off = project('docs-init-off')
  await init(
    {
      config: path.join(off.dir, 'shapewall.config.json'),
      'base-url': 'http://localhost:3000',
      'no-discover': true,
      'no-agent-docs': true,
    },
    () => {},
    { fetch },
  )
  assert.equal(exists(off.dir, 'AGENTS.md'), false)
})

test('agent docs: status, --write, --remove, --print', () => {
  const { dir } = project('docs-command')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ title: 'T', baseUrl: 'http://localhost:3000', pages: [{ id: 'home', path: '/', title: 'Home' }] }),
  )
  const run = (flags) => {
    const lines = []
    assert.equal(
      agentDocsCommand({ config: file, ...flags }, (line) => lines.push(line)),
      0,
    )
    return lines.join('\n')
  }
  assert.match(run({}), /No Shapewall section.*\n.*would: create AGENTS\.md, create CLAUDE\.md/)
  assert.match(run({ write: true }), /Wrote the Shapewall section/)
  assert.match(run({ write: true }), /up to date/)
  assert.match(run({}), /The Shapewall section is in AGENTS\.md/)
  assert.match(run({ remove: true }), /Removed the Shapewall section from AGENTS\.md/)
  assert.match(run({}), /removed with agent docs --remove/)
  assert.equal(run({ print: true }), agentDocsBlock())
})
