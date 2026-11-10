// A stand-in for a coding agent, run by `shapewall watch --exec` in tests.
// Usage: fake-agent.mjs <out-dir>. Reads the comment JSON from stdin, records
// what it got, and acts on the comment body: "fail" exits 3, "hang" never
// finishes, "resolve" resolves the comment through the CLI, "reply" replies
// through the CLI and exits 0, anything else exits 0 without a word.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const outDir = process.argv[2]
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'shapewall.js')
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('SHAPEWALL_')))
fs.writeFileSync(path.join(outDir, `got-${env.SHAPEWALL_COMMENT_ID}.json`), JSON.stringify({ input, env, argv: process.argv.slice(2) }))
const body = input.comment.body
if (body === 'fail') {
  console.error('could not do it')
  process.exit(3)
}
if (body === 'hang') await new Promise((resolve) => setTimeout(resolve, 60000))
if (body === 'reply' && env.SHAPEWALL_CONFIG) {
  execFileSync(process.execPath, [
    bin,
    'comments',
    'reply',
    env.SHAPEWALL_COMMENT_ID,
    '--body',
    'Fixed it',
    '--config',
    env.SHAPEWALL_CONFIG,
  ])
}
if (body === 'resolve') {
  execFileSync(process.execPath, [
    bin,
    'comments',
    'resolve',
    env.SHAPEWALL_COMMENT_ID,
    '--note',
    'Done by the fake agent',
    '--config',
    env.SHAPEWALL_CONFIG,
  ])
}
console.log(`handled #${env.SHAPEWALL_COMMENT_ID}`)
