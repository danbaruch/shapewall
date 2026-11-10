#!/usr/bin/env node
// Checks what `npm pack` would put in the published tarball: the runtime
// (bin, src, the built clients, licences) and nothing from development
// (tests, fixtures, captures, auth files, the website, client sources).
// CI runs it after the build: `npm run check:pack`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const USER_GUIDES = [
  'docs/agent-hardening.md',
  'docs/agent-recipes.md',
  'docs/agent-workflow.md',
  'docs/agents.md',
  'docs/buzz.md',
  'docs/architecture.md',
  'docs/capture-warnings.md',
  'docs/config.md',
  'docs/deployment.md',
  'docs/design-system.md',
  'docs/github.md',
  'docs/hosted.md',
  'docs/interaction-audits.md',
  'docs/journeys.md',
  'docs/local-accounts.md',
  'docs/notifications.md',
  'docs/page-checks.md',
  'docs/pull-requests.md',
  'docs/performance.md',
  'docs/starter-agent.md',
  'docs/updates.md',
]

export const USER_GUIDE_IMAGES = [
  'docs/images/board-overview.png',
  'docs/images/journeys.png',
  'docs/images/live-comment.png',
  'docs/images/phone-comment.png',
  'docs/images/phone-overview.png',
  'docs/images/variant.png',
]
const DOCUMENTATION = new Set([...USER_GUIDES, ...USER_GUIDE_IMAGES])

export const REQUIRED = [
  'package.json',
  'bin/shapewall.js',
  'src/cli.js',
  'src/hosted/LICENSE.md',
  'dist/client/index.html',
  'dist/console/console.html',
  'dist/agent/package-lock.json',
  'Dockerfile.agent',
  'README.md',
  ...USER_GUIDES,
  ...USER_GUIDE_IMAGES,
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY.md',
  'examples/audits/interaction.audit.json',
]

export const FORBIDDEN = [
  [/^test\//, 'tests'],
  [/(^|\/)(__)?fixtures?(__)?\//, 'test fixtures'],
  [/\.test\.[cm]?js$/, 'tests'],
  [/(^|\/)\.shapewall(\/|$)/, 'captures and comments (.shapewall)'],
  [/(^|\/)shapewall-export\//, 'an export'],
  [/\.auth\.json$/, 'a login state file'],
  [/(^|\/)\.env(\.|$)/, 'an env file'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/^(website|client|scripts|brand)\//, 'development sources'],
  [/^examples\/(?!audits\/interaction\.audit\.json$)/, 'development examples'],
  [/^\.github\//, 'CI config'],
  [/^dist\/demo\//, 'the demo build'],
  [/\.(log|tgz)$/, 'logs or tarballs'],
]

// Packed size limit: the built clients (with the voice worker) are about
// 7 MB packed today; well past that means something extra got in.
export const PACKED_MAX = 15 * 1024 * 1024

// Problems with a tarball's file list (paths relative to the package root).
export function checkPackFiles(files, { size = 0 } = {}) {
  const problems = []
  const have = new Set(files)
  for (const file of REQUIRED) if (!have.has(file)) problems.push(`missing ${file}`)
  for (const file of files) {
    if (file.startsWith('docs/') && !DOCUMENTATION.has(file)) problems.push(`should not ship ${file} (non-user documentation)`)
    const hit = FORBIDDEN.find(([pattern]) => pattern.test(file))
    if (hit) problems.push(`should not ship ${file} (${hit[1]})`)
  }
  if (size > PACKED_MAX) problems.push(`packed size ${(size / 1048576).toFixed(1)} MB is over ${PACKED_MAX / 1048576} MB`)
  return problems
}

// `npm pack --dry-run --json`, run with its lifecycle scripts (prepack adds
// dist/agent/package-lock.json), whose output comes before the JSON.
export function packList({ cwd = ROOT } = {}) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`npm pack failed:\n${result.stderr || result.stdout}`)
  const start = result.stdout.search(/^\[\s*$/m)
  if (start < 0) throw new Error(`npm pack printed no JSON:\n${result.stdout}`)
  const [pack] = JSON.parse(result.stdout.slice(start))
  return { files: pack.files.map((file) => file.path), size: pack.size, name: pack.filename }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(ROOT, 'dist/client/index.html'))) {
    console.error('Build first: npm run build')
    process.exit(1)
  }
  const { files, size, name } = packList()
  const problems = checkPackFiles(files, { size })
  if (problems.length) {
    console.error(`${name}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`${name}: ${files.length} files, ${(size / 1048576).toFixed(1)} MB packed, contents ok`)
}
