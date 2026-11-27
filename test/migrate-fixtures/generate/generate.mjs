// Makes one migrate fixture with a released Shapewall: the .shapewall/ folder
// of a two-page fixture app, captured twice (so it has versions), once more
// on a second environment, with a variant, comments, replies, reactions,
// images, a drawing, a journey, chat threads and a local account, all
// written by THAT version's own code (data.mjs imports its modules).
//
//   node test/migrate-fixtures/generate/generate.mjs <out dir> <package root>
//
// <package root>: an installed shapewall package of the version, e.g. the
// folder `npx shapewall@1.1.0 --version` left in the npm cache, or an
// unpacked release commit with its dependencies installed. Run it in a
// scratch folder (HOME and XDG_CONFIG_HOME are pointed into <out dir>, so no
// personal settings are read or written) and with a Chromium Playwright can
// find (PLAYWRIGHT_BROWSERS_PATH). The committed fixtures were made with
// 0.3.1, 0.12.6, 1.0.1, 1.1.0 (npm) and 1.2.0 (release commit 8ee3f18,
// never published), then each accounts.sqlite was VACUUMed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [outDir, pkgRoot] = process.argv.slice(2).map((arg) => path.resolve(arg))
if (!outDir || !pkgRoot) throw new Error('usage: generate.mjs <out dir> <package root>')
fs.mkdirSync(outDir, { recursive: true })
const home = path.join(outDir, '.home')
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, 'xdg'),
  XDG_STATE_HOME: path.join(home, 'state'),
  CI: '1',
}
const sites = [4891, 4892].map((port, i) =>
  spawn(process.execPath, [path.join(here, 'site.mjs'), String(port), i ? 'Staging' : 'Default'], { stdio: 'ignore' }),
)
await new Promise((resolve) => setTimeout(resolve, 500))
const config = {
  title: 'Fixture Site',
  id: 'site',
  outputDir: '.shapewall',
  concurrency: 1,
  viewports: { desktop: { width: 800, height: 600 }, phone: { width: 390, height: 640 } },
  environments: [
    { id: 'local', baseUrl: 'http://127.0.0.1:4891' },
    { id: 'staging', baseUrl: 'http://127.0.0.1:4892' },
  ],
  pages: [
    { id: 'home', path: '/', title: 'Home' },
    { id: 'pricing', path: '/pricing', title: 'Pricing' },
  ],
}
fs.writeFileSync(path.join(outDir, 'shapewall.config.json'), `${JSON.stringify(config, null, 2)}\n`)
const run = (...args) => {
  const result = spawnSync(process.execPath, [path.join(pkgRoot, 'bin', 'shapewall.js'), ...args], { cwd: outDir, env, encoding: 'utf8' })
  console.log(`shapewall ${args.join(' ')}: exit ${result.status}`)
}
try {
  run('capture')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  run('capture')
  run('capture', '--env', 'staging')
  run('variant', 'add', 'home', '--path', '/pricing', '--title', 'Alt hero', '--id', 'alt-hero')
  const data = spawnSync(process.execPath, [path.join(here, 'data.mjs'), pkgRoot, outDir], { env, encoding: 'utf8' })
  console.log(data.stdout)
} finally {
  for (const site of sites) site.kill()
  fs.rmSync(home, { recursive: true, force: true })
}
