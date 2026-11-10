import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))

// A tarball install resolves the runtime dependencies fresh,
// without our lockfile, so a range can pull a broken release (playwright
// 1.65.0 shipped before its playwright-core). Exact versions only.
test('runtime dependencies are exact versions that match the lockfile', () => {
  const pkg = read('package.json')
  const lock = read('package-lock.json')
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name}: "${version}" is not an exact version`)
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name}: the lockfile has another version`)
    assert.equal(lock.packages['']?.dependencies?.[name], version, `${name}: the lockfile root lists another range`)
  }
})

// The tarball check CI runs (scripts/check-pack.js): the rules, on made-up lists.
test('package contents check: required runtime files in, development files out', async () => {
  const { REQUIRED, checkPackFiles } = await import('../scripts/check-pack.js')
  assert.deepEqual(checkPackFiles([...REQUIRED, 'src/store.js', 'dist/client/assets/app.js']), [])
  const bad = checkPackFiles(
    [
      ...REQUIRED.filter((file) => file !== 'bin/shapewall.js'),
      'test/cli.test.js',
      'src/capture/fixtures/page.html',
      '.shapewall/site/manifest.json',
      'site/.shapewall/comments.json',
      'login.auth.json',
      '.env.local',
      'website/index.html',
      'client/src/main.jsx',
      'dist/demo/index.html',
      'docs/READINESS_REVIEW.md',
      'docs/private-capture.json',
      'docs/images/private.png',
    ],
    { size: 40 * 1024 * 1024 },
  )
  assert.ok(bad.includes('missing bin/shapewall.js'))
  const dropped = [
    'test/cli.test.js',
    'src/capture/fixtures/page.html',
    '.shapewall/site/manifest.json',
    'site/.shapewall/comments.json',
    'login.auth.json',
    '.env.local',
    'website/index.html',
    'client/src/main.jsx',
    'dist/demo/index.html',
    'docs/READINESS_REVIEW.md',
    'docs/private-capture.json',
    'docs/images/private.png',
  ]
  for (const file of dropped)
    assert.ok(
      bad.some((line) => line.startsWith(`should not ship ${file} `)),
      file,
    )
  assert.ok(bad.some((line) => /packed size/.test(line)))
})

test('only the fictional interaction audit example may ship from examples', async () => {
  const { REQUIRED, checkPackFiles } = await import('../scripts/check-pack.js')
  assert.ok(REQUIRED.includes('examples/audits/interaction.audit.json'))
  assert.deepEqual(checkPackFiles(REQUIRED), [])
  for (const file of [
    'examples/audits/private.auth.json',
    'examples/audits/other.json',
    'examples/demo-site/index.html',
    'examples/audits/interaction.audit.json/secrets',
  ])
    assert.ok(checkPackFiles([...REQUIRED, file]).some((problem) => problem.includes(file)))
})
