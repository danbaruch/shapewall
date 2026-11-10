// npm run demo: start the bundled demo site, capture it, and serve the board.
//   --capture-only   capture and exit (no board server)
//   --no-capture     serve the existing captures
//   --full           the whole fictional product (shapewall.full.config.json, 26 pages)
// Ports: DEMO_SITE_PORT (default 4601, the demo config's port; "Capture now"
// in the board always uses the config's port) and SHAPEWALL_PORT (default 4600).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startDemoSite } from '../examples/demo-site/server.js'
import { loadConfig } from '../src/config.js'
import { runCapture } from '../src/capture/capture.js'
import { createApp, stopChildren } from '../src/server/app.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const CONFIG = path.join(ROOT, 'examples', 'demo-site', args.has('--full') ? 'shapewall.full.config.json' : 'shapewall.config.json')

if (!args.has('--capture-only') && !fs.existsSync(path.join(ROOT, 'dist', 'client', 'index.html'))) {
  console.log('Building the client first (npm run build)...')
  const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status || 1)
}

const config = loadConfig(CONFIG)
const sitePort = Number(new URL(config.boards[0].baseUrl).port)
let site
try {
  site = await startDemoSite({ port: process.env.DEMO_SITE_PORT === undefined ? sitePort : Number(process.env.DEMO_SITE_PORT) })
} catch (error) {
  console.error(
    `The demo site could not start (${error.code || error.message}). Set DEMO_SITE_PORT to another port, or 0 for any free one.`,
  )
  process.exit(1)
}
// The board captures whatever port the demo site really got.
config.boards[0].baseUrl = `http://127.0.0.1:${site.address().port}`
console.log(`Demo site at ${config.boards[0].baseUrl}`)

let server = null
let app = null
const shutdown = (code = 0) => {
  if (app) stopChildren(app)
  site.close()
  if (server) server.close()
  process.exit(code)
}
process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))

try {
  if (!args.has('--no-capture')) await runCapture({ config, log: (line) => console.log(line) })
} catch (error) {
  console.error(`Capture failed: ${error.message}`)
  shutdown(1)
}

if (args.has('--capture-only')) shutdown(0)
else {
  app = createApp({ config, log: (line) => console.log(line) })
  const port = process.env.SHAPEWALL_PORT === undefined ? 4600 : Number(process.env.SHAPEWALL_PORT)
  server = app.listen(port, '127.0.0.1', () => {
    console.log(`\nShapewall board: http://127.0.0.1:${server.address().port}/  (Ctrl-C to stop)`)
  })
}
