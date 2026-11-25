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
  writeAgentDocsSetting,
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

  // A section someone committed is left as it is, and nothing else is made.
  const committed = project('docs-once-committed')
  fs.writeFileSync(path.join(committed.dir, 'CLAUDE.md'), `${agentDocsBlock()}\n`)
  assert.equal(addAgentDocsOnce(projectConfig(committed.dir), { env: NO_CI }), null)
  assert.equal(read(committed.dir, 'CLAUDE.md'), `${agentDocsBlock()}\n`)
  assert.equal(exists(committed.dir, 'AGENTS.md'), false)
})

test('first serve or capture never edits an AGENTS.md or CLAUDE.md that is there: one hint line, once per checkout', () => {
  // A fresh clone of a project whose AGENTS.md had the section removed by hand (no .shapewall/ record).
  const clone = project('docs-once-clone')
  fs.writeFileSync(path.join(clone.dir, 'AGENTS.md'), '# Team rules\n')
  const config = projectConfig(clone.dir)
  assert.equal(
    addAgentDocsOnce(config, { env: NO_CI }),
    'AGENTS.md has no Shapewall section; "shapewall agent docs --write" adds one so coding agents find the board.',
  )
  assert.equal(read(clone.dir, 'AGENTS.md'), '# Team rules\n')
  assert.equal(exists(clone.dir, 'CLAUDE.md'), false)
  assert.equal(addAgentDocsOnce(config, { env: NO_CI }), null)

  const claudeOnly = project('docs-once-claude')
  fs.writeFileSync(path.join(claudeOnly.dir, 'CLAUDE.md'), '# C\n')
  assert.match(addAgentDocsOnce(projectConfig(claudeOnly.dir), { env: NO_CI }), /^CLAUDE\.md has no Shapewall section/)
  assert.equal(read(claudeOnly.dir, 'CLAUDE.md'), '# C\n')

  // A section with markers Shapewall cannot read is left alone, without a hint.
  const broken = project('docs-once-broken')
  fs.writeFileSync(path.join(broken.dir, 'AGENTS.md'), `${START_MARKER}\nno end\n`)
  assert.equal(addAgentDocsOnce(projectConfig(broken.dir), { env: NO_CI }), null)

  // "agentDocs": true in the config: the project decided; serve and capture do nothing.
  const on = project('docs-once-true')
  assert.equal(addAgentDocsOnce(projectConfig(on.dir, { agentDocs: true }), { env: NO_CI }), null)
  assert.equal(exists(on.dir, 'AGENTS.md'), false)
})

test('a config with agentDocs that is not a boolean is refused; unset reads as null', () => {
  const { dir } = project('docs-config')
  assert.throws(() => projectConfig(dir, { agentDocs: 'no' }), /agentDocs: true or false/)
  assert.equal(projectConfig(dir).agentDocs, null)
  assert.equal(projectConfig(dir, { agentDocs: true }).agentDocs, true)
})

test('writeAgentDocsSetting changes only that key: in place, added after the brace, or the whole file as a last resort', () => {
  const { dir } = project('docs-setting')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, '{\n    "title": "T",   "pages": []\n}\n')
  assert.equal(writeAgentDocsSetting(file, false), true)
  assert.equal(read(dir, 'shapewall.config.json'), '{\n    "agentDocs": false,\n    "title": "T",   "pages": []\n}\n')
  assert.equal(writeAgentDocsSetting(file, false), false)
  assert.equal(writeAgentDocsSetting(file, true), true)
  assert.equal(read(dir, 'shapewall.config.json'), '{\n    "agentDocs": true,\n    "title": "T",   "pages": []\n}\n')
  // A nested "agentDocs" is not the config's: the top-level one is added.
  fs.writeFileSync(file, '{"x": {"agentDocs": true}}')
  writeAgentDocsSetting(file, false)
  assert.deepEqual(JSON.parse(read(dir, 'shapewall.config.json')), { x: { agentDocs: true }, agentDocs: false })
  fs.writeFileSync(file, '[]')
  assert.throws(() => writeAgentDocsSetting(file, false), /not a JSON object/)
})

test('a newer Shapewall section is left as it is; removing it still works', () => {
  const { dir, outputDir } = project('docs-newer')
  const newer = '# A\n\n<!-- shapewall:start v2 -->\nnewer words\n<!-- shapewall:end -->\n'
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), newer)
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
  const result = writeAgentDocs(dir, outputDir)
  assert.equal(result.changed, false)
  assert.equal(read(dir, 'AGENTS.md'), newer)
  assert.match(result.notes.join(' '), /AGENTS\.md has a section from a newer Shapewall \(v2\)/)
  removeAgentDocs(dir, outputDir)
  assert.equal(read(dir, 'AGENTS.md'), '# A\n')
})

test('markers: a second start before the end is refused; markers in fenced code blocks do not count', () => {
  const nested = `# Mine\n${START_MARKER}\nold\n${START_MARKER}\nmine inside\n${END_MARKER}\nMY NOTES\n${END_MARKER}\n`
  assert.throws(() => withBlock(nested, 'AGENTS.md'), /second "<!-- shapewall:start v1 -->" line before/)
  assert.throws(() => withoutBlock(nested, 'AGENTS.md'), /second/)
  const fenced = `# Docs\nThe markers look like this:\n\`\`\`md\n${START_MARKER}\n(your section)\n${END_MARKER}\n\`\`\`\nMore of my text\n`
  assert.equal(findBlock(fenced), null)
  assert.equal(withoutBlock(fenced), null)
  const text = withBlock(fenced, 'AGENTS.md')
  assert.ok(text.startsWith(fenced))
  assert.deepEqual(findBlock(text), { start: 9, end: text.split('\n').length - 2, version: 1 })
  // ~~~ fences too, and a longer closing fence closes a shorter one.
  const tilde = `~~~~\n${START_MARKER}\n~~~\nstill fenced\n${END_MARKER}\n~~~~~\n`
  assert.equal(findBlock(tilde), null)
})

test('mixed line endings: lines outside the section keep their own', () => {
  const before = '# A\r\nunix line\nwindows line\r\n'
  const text = withBlock(before, 'AGENTS.md')
  assert.ok(text.startsWith('# A\r\nunix line\nwindows line\r\n'))
  assert.equal(withoutBlock(text, 'AGENTS.md'), before)
  const inside = `top\n${START_MARKER}\r\nold\r\n${END_MARKER}\r\nbottom\n`
  const replaced = withBlock(inside, 'AGENTS.md')
  assert.ok(replaced.startsWith('top\n'))
  assert.ok(replaced.endsWith(`${END_MARKER}\r\nbottom\n`))
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
  // Kept in the config, so the first serve or capture does not add it either.
  const config = JSON.parse(read(off.dir, 'shapewall.config.json'))
  assert.equal(config.agentDocs, false)
  const normalized = normalizeConfig(config, { dir: off.dir, file: path.join(off.dir, 'shapewall.config.json') })
  assert.equal(addAgentDocsOnce(normalized, { env: NO_CI }), null)
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
  const removed = run({ remove: true })
  assert.match(removed, /Removed the Shapewall section from AGENTS\.md/)
  // Kept in the committed config, so a fresh clone does not get it back.
  assert.match(removed, /Set "agentDocs": false in shapewall\.config\.json/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agentDocs, false)
  assert.match(run({}), /The config says "agentDocs": false/)
  assert.match(run({ remove: true }), /already has "agentDocs": false/)
  assert.equal(run({ print: true }), agentDocsBlock())
})
