// The stable surfaces keep their 1.x shapes on the solo engine (2.0.0, plan
// R5): what a script or an agent built on 1.x reads must still be there
// once `serve` runs the engine and the project's data moved into it.
//
// The 1.x snapshot is test/fixtures/contract-1x.json: the shape (keys and
// value types, no values) of each surface as the 1.x board files produce it.
// This test first checks that the 1.x path (the JSON files, which 2.x keeps
// behind --engine legacy) still matches the snapshot exactly, so the snapshot
// cannot drift; then it migrates the same project, starts the engine and
// checks that each surface there has every key of the snapshot, with the
// same type (a value may be null on one side; new keys are allowed, as
// docs/stability.md promises: "read JSON tolerantly").
//
// Surfaces: the MCP tools and their arguments (with the local `author`), the
// comment item of `comments list|get --json` and of `watch` (one serializer,
// src/feedback.js feedbackItem, shared with /api/v1), the --json of `comments
// add|reply`, the JSON a `watch --exec` program gets on stdin, and the lines
// of events.jsonl.
//
// SHAPEWALL_UPDATE_CONTRACT=1 rewrites the snapshot from the 1.x path (only
// when a 1.x surface changed on purpose, additively).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { createMcpServer } from '../src/mcp.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { createRemote } from '../src/remote/remote.js'
import { pinSoloLoopback } from '../src/remote/loopback-pin.js'
import { engineTarget } from '../src/engine-target.js'
import { migrateCommand } from '../src/migrate/index.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { serveEngine } from '../src/hosted/solo/serve.js'
import { addReply, createComment } from '../src/store.js'
import { SAMPLE, isolatedEnv, tempDir } from './helpers.js'
import { createBrowser } from './hosted-helpers.js'

quietSqliteWarning()

const SNAPSHOT = fileURLToPath(new URL('./fixtures/contract-1x.json', import.meta.url))
const ENV = isolatedEnv('contract-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })
const noExit = (options) => startHosted({ ...options, exitOnStop: false })

// ---- shapes --------------------------------------------------------------

// The shape of a JSON value: object keys (sorted) to shapes, an array's
// elements merged into one shape, a primitive's type.
export function shape(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return value.length ? [value.map(shape).reduce(merge)] : []
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape(value[key])]),
    )
  return typeof value
}

function merge(a, b) {
  if (a === 'null') return b
  if (b === 'null') return a
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [merge(a[0], b[0])] : a.length ? a : b
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a }
    for (const [key, value] of Object.entries(b)) out[key] = key in out ? merge(out[key], value) : value
    return Object.fromEntries(
      Object.keys(out)
        .sort()
        .map((key) => [key, out[key]]),
    )
  }
  return a
}

// Where `actual` lacks what `wanted` (the 1.x snapshot) has: a list of paths.
export function missing(actual, wanted, at = '$') {
  if (wanted === 'null' || actual === 'null') return []
  if (Array.isArray(wanted)) {
    if (!Array.isArray(actual)) return [`${at}: an array in 1.x, ${JSON.stringify(actual)} here`]
    if (!wanted.length || !actual.length) return []
    return missing(actual[0], wanted[0], `${at}[]`)
  }
  if (typeof wanted === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return [`${at}: an object in 1.x, ${JSON.stringify(actual)} here`]
    return Object.keys(wanted).flatMap((key) =>
      key in actual ? missing(actual[key], wanted[key], `${at}.${key}`) : [`${at}.${key}: missing (1.x has it)`],
    )
  }
  return actual === wanted ? [] : [`${at}: ${wanted} in 1.x, ${JSON.stringify(actual)} here`]
}

test('shape() and missing(): keys and types, null either side, new keys allowed', () => {
  assert.deepEqual(shape({ b: 1, a: [{ x: 'y' }, { z: null }] }), { a: [{ x: 'string', z: 'null' }], b: 'number' })
  assert.deepEqual(missing({ a: 'string', extra: 'number' }, { a: 'string' }), [])
  assert.deepEqual(missing({ a: 'null' }, { a: 'string' }), [])
  assert.deepEqual(missing({}, { a: 'string' }), ['$.a: missing (1.x has it)'])
  assert.deepEqual(missing({ a: 'number' }, { a: 'string' }), ['$.a: string in 1.x, "number" here'])
  assert.deepEqual(missing({ a: [{ b: 'string' }] }, { a: [{ b: 'string', c: 'number' }] }), ['$.a[].c: missing (1.x has it)'])
})

// ---- the project and its two paths ----------------------------------------

function project(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Contract Notes' }, null, 2))
  return loadConfig(file)
}

async function cli(argv) {
  const lines = []
  const errs = []
  const code = await main(argv, { out: (line) => lines.push(String(line)), err: (line) => errs.push(String(line)) })
  return { code, out: lines.join('\n'), err: errs.join('\n') }
}

const json = async (argv) => {
  const run = await cli(argv)
  assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err}`)
  return JSON.parse(run.out)
}

async function mcpTools(server) {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'contract', version: '1.0.0' })
  await server.connect(a)
  await client.connect(b)
  try {
    const { tools } = await client.listTools()
    return Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        Object.fromEntries(
          Object.keys(tool.inputSchema?.properties || {})
            .sort()
            .map((arg) => [arg, 'arg']),
        ),
      ]),
    )
  } finally {
    await client.close()
  }
}

// The lines of .shapewall/events.jsonl, from line `from` on (the engine keeps the file the 1.x board wrote).
const eventsOf = (config, from = 0) =>
  fs
    .readFileSync(path.join(config.outputDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(from)
    .map((line) => JSON.parse(line))

// The surfaces of the project as it is now (whichever path the commands take).
async function surfaces(config, { ownerComment }) {
  const file = config.file
  const from = fs.existsSync(path.join(config.outputDir, 'events.jsonl')) ? eventsOf(config).length : 0
  const listed = await json(['comments', 'list', '--config', file, '--json', '--all'])
  const id = String(listed.comments[0].id)
  const got = await json(['comments', 'get', id, '--config', file, '--json'])
  const replied = await json([
    'comments',
    'reply',
    id,
    '--config',
    file,
    '--body',
    'Done, see the new capture',
    '--author',
    'Fixer',
    '--json',
  ])
  const added = await json(['comments', 'add', '--config', file, '--page', 'home', '--body', 'Agent note', '--author', 'Fixer', '--json'])
  // watch --exec (first: a plain watch --once queues every open comment): the JSON its program gets on stdin.
  await ownerComment('Exec me')
  const script = path.join(config.dir, 'take.cjs')
  const stdin = path.join(config.dir, 'stdin.json')
  fs.rmSync(stdin, { force: true })
  fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2], require('fs').readFileSync(0))\n")
  const exec = await cli(['watch', '--once', '--config', file, '--exec', `${process.execPath} ${script} ${stdin}`])
  assert.equal(exec.code, 0, exec.err)
  assert.ok(fs.existsSync(stdin), `watch --exec: ${exec.out} ${exec.err}`)
  const execJson = JSON.parse(fs.readFileSync(stdin, 'utf8'))
  // watch: the JSON line it prints.
  await ownerComment('Watch me')
  const watched = await cli(['watch', '--once', '--config', file])
  assert.equal(watched.code, 0, watched.err)
  const handed = watched.out
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
  assert.ok(handed.length, `watch handed nothing: ${watched.out} ${watched.err}`)
  assert.ok(eventsOf(config, from).length >= 3, 'events.jsonl got the lines of this run')
  return {
    labels: { reply: replied.reply?.author, comment: added.comment?.author },
    shapes: {
      commentsList: shape(listed),
      commentsGet: shape(got),
      commentsReply: shape(replied),
      commentsAdd: shape(added),
      watchLine: shape(handed[0]),
      watchExec: shape(execJson),
      events: shape(eventsOf(config, from)),
    },
  }
}

test('the stable surfaces on the solo engine keep the 1.x shapes (contract)', async (t) => {
  const config = project('contract-1x')
  const board = config.boards[0]
  const made = await createComment(config, board, {
    pageId: 'home',
    viewport: 'desktop',
    x: 12,
    y: 20,
    body: 'Make the logo bigger',
    author: 'Robin Tester',
    anchor: { selector: 'a[data-testid="plus-cta"]', text: 'Try Plus', dx: 0.5, dy: 0.5 },
  })
  await addReply(config, board.id, made.id, { body: 'Bigger how?', author: 'agent' })

  // 1.x: the JSON files.
  const before = await surfaces(config, {
    // A person's comment on the 1.x board, made by the board's owner (a comment watch hands out).
    ownerComment: (body) => createComment(config, board, { pageId: 'pricing', viewport: 'phone', x: 5, y: 5, body }, { owner: true }),
  })
  const localTools = await mcpTools(createMcpServer({ config, env: ENV }))
  assert.deepEqual(before.labels, { reply: 'Fixer', comment: 'Fixer' }, 'the 1.x author labels')
  const snapshot1x = { mcpTools: localTools, ...before.shapes }
  if (process.env.SHAPEWALL_UPDATE_CONTRACT === '1') fs.writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot1x, null, 2)}\n`)
  const fixture = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
  assert.deepEqual(snapshot1x, fixture, 'the 1.x path still matches the committed 1.x snapshot')

  // 2.x: migrate (what the first `serve` does) and start the engine.
  const lines = []
  assert.equal(await migrateCommand(config, {}, (line) => lines.push(line), { env: ENV }), 0, lines.join('\n'))
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0, 'no-chat': true }, () => {}, {
    env: ENV,
    start: noExit,
  })
  t.after(() => handle.stop())
  await pinSoloLoopback()
  const ownerComment = async (body) => {
    const page = handle.app.locals.soloOpenFile()
    const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(page, 'utf8'))[1]
    const browser = createBrowser(handle.server.address().port, handle.origin)
    const opened = await browser.post('/open', 'nonce=' + nonce, {
      sendOrigin: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
    })
    assert.equal(opened.status, 200, opened.text)
    const { workspaceId, projectId } = handle.app.locals.solo.owner
    const res = await browser.post(`/w/${workspaceId}/p/${projectId}/api/boards/sample/comments`, {
      pageId: 'pricing',
      viewport: 'phone',
      x: 5,
      y: 5,
      body,
    })
    assert.equal(res.status, 201, res.text)
  }
  const after = await surfaces(config, { ownerComment })
  const target = engineTarget(config)
  const engineTools = await mcpTools(
    // As `shapewall mcp` starts it in the folder (src/cli/commands.js): the project config, so recapture_pages is offered.
    await createRemoteMcpServer({
      remote: createRemote({ origin: target.origin, token: target.token, source: 'engine' }),
      config,
      localAuthor: true,
    }),
  )

  // The author labels: what 1.x wrote, still an agent's.
  assert.deepEqual(after.labels, { reply: 'Fixer', comment: 'Fixer' }, 'the --author label on the engine')

  // Every 1.x tool and argument, except the capture tools 1.x has only in place (see above).
  const problems = []
  for (const [tool, args] of Object.entries(fixture.mcpTools)) {
    if (!engineTools[tool]) {
      problems.push(`mcp ${tool}: missing on the engine`)
      continue
    }
    for (const arg of Object.keys(args)) if (!(arg in engineTools[tool])) problems.push(`mcp ${tool}(${arg}): missing on the engine`)
  }
  for (const [name, wanted] of Object.entries(fixture)) {
    if (name === 'mcpTools') continue
    problems.push(...missing(after.shapes[name], wanted, name))
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})
