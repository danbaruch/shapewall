import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { ttsWorker } from '../scripts/vite-tts.js'
import { tempDir } from './helpers.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const hosted = path.join(root, 'src', 'hosted') + path.sep

test('core, browser and build sources do not import the hosted implementation', () => {
  const violations = []
  const files = fs.globSync(['{bin,src,client,scripts}/**/*.{js,jsx,mjs,cjs}', 'vite*.js'], { cwd: root, exclude: ['src/hosted/**'] })
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const refs = source.matchAll(/\b(from\s+|import\s*\(\s*|import\s+|require\s*\(\s*|new URL\(\s*)['"`]([^'"`]+)['"`]/g)
    for (const [, kind, specifier] of refs) {
      if (!specifier.startsWith('.')) continue
      const target = path.resolve(root, path.dirname(file), specifier)
      if (!target.startsWith(hosted)) continue
      if (file === 'src/cli.js' && kind.startsWith('import(') && specifier === './hosted/ops-cli.js') continue
      // `shapewall migrate` writes the solo engine's database, so it lives with the engine (src/hosted/migrate).
      if (file === 'src/cli.js' && kind.startsWith('import(') && specifier === './hosted/migrate/index.js') continue
      violations.push(`${file} imports ${specifier}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('the board build rejects a resolved hosted input before publishing assets', async () => {
  const entry = 'virtual:license-probe'
  const hostedImport = path.join(hosted, 'permissions.js')
  await assert.rejects(
    build({
      configFile: path.join(root, 'vite.config.js'),
      logLevel: 'silent',
      plugins: [
        {
          name: 'license-probe',
          resolveId: (id) => (id === entry ? '\0' + entry : null),
          load: (id) => (id === '\0' + entry ? `export * from ${JSON.stringify(hostedImport)}` : null),
        },
      ],
      build: { write: false, rollupOptions: { input: entry } },
    }),
    /browser bundle includes a hosted server module/,
  )
})

test('a hosted dependency in the worker is rejected by the worker build itself', async () => {
  const dir = tempDir('license-worker')
  const entry = path.join(dir, 'entry.js')
  fs.writeFileSync(entry, "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })")
  fs.writeFileSync(path.join(dir, 'worker.js'), `import ${JSON.stringify(path.join(hosted, 'permissions.js'))}`)
  await assert.rejects(
    build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      worker: ttsWorker(),
      build: { write: false, rollupOptions: { input: entry } },
    }),
    /browser bundle includes a hosted server module/,
  )
})
