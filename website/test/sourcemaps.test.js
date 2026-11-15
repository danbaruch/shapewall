// Source maps for our own GlitchTip (shapewall.com and the demo only): the shared step always deletes the maps and
// never rewrites built JS, and the Shapewall package build never runs it. Run: npm test (from website/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8')
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })

test('the site and demo builds make hidden maps and run the sourcemaps step; the package builds do not', () => {
  for (const file of ['website/vite.config.js', 'vite.demo.config.js']) {
    const config = read(file)
    assert.match(config, /debugIds\(\)/, file)
    assert.match(config, /sourcemapsStep\(/, file)
    assert.match(config, /sourcemap: (isSsrBuild \? false : )?'hidden'/, file)
  }
  for (const file of ['vite.config.js', 'vite.console.config.js']) {
    const config = read(file)
    assert.doesNotMatch(config, /sourcemaps|debugIds|debug-ids|sourcemap:/, file)
  }
  const pkg = JSON.parse(read('package.json'))
  assert.ok(!pkg.files.some((entry) => entry === 'scripts' || entry.startsWith('scripts/')), 'scripts/ must not ship in the package')
})

test('sourcemaps step deletes every map and leaves JS untouched without a token or sentry-cli', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sourcemaps-'))
  try {
    const js = 'console.log(1)\n;//# debugId=00000000-0000-4000-8000-000000000000\n'
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'assets', 'a.js'), js)
    fs.writeFileSync(
      path.join(dist, 'assets', 'a.js.map'),
      JSON.stringify({ version: 3, debug_id: '00000000-0000-4000-8000-000000000000' }),
    )
    fs.writeFileSync(path.join(dist, 'b.css.map'), '{}')
    const env = {
      ...process.env,
      SENTRY_CLI: path.join(dist, 'missing-sentry-cli'),
      GLITCHTIP_UPLOAD_ENV: path.join(dist, 'missing.env'),
    }
    delete env.SENTRY_URL
    delete env.SENTRY_ORG
    delete env.SENTRY_AUTH_TOKEN
    execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'sourcemaps.mjs'), '--dist', dist, '--project', 'shapewall', '--release', 'abc1234'],
      { env, stdio: 'pipe' },
    )
    assert.deepEqual(
      walk(dist).map((file) => path.relative(dist, file)),
      [path.join('assets', 'a.js')],
    )
    assert.equal(fs.readFileSync(path.join(dist, 'assets', 'a.js'), 'utf8'), js)
  } finally {
    fs.rmSync(dist, { recursive: true, force: true })
  }
})
