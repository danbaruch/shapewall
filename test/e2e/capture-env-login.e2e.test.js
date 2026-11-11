// A login script signs in to the environment being captured: it gets that
// environment's baseUrl, not always the first one's.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { runCapture } from '../../src/capture/capture.js'
import { normalizeConfig } from '../../src/config.js'
import { ROOT_DIR } from './helpers.js'

let first, second, config, seen
const close = (server) => new Promise((resolve) => server.close(resolve))

before(async () => {
  first = await startDemoSite({ port: 0 })
  second = await startDemoSite({ port: 0 })
  const dir = path.join(ROOT_DIR, 'test', '.output', 'capture-env-login')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  seen = path.join(dir, 'seen.txt')
  fs.writeFileSync(
    path.join(dir, 'login.mjs'),
    `import fs from 'node:fs'\nexport default async function login({ baseUrl }) {\n  fs.appendFileSync(${JSON.stringify(seen)}, baseUrl + '\\n')\n}\n`,
  )
  const raw = {
    title: 'Two places',
    id: 'two',
    outputDir: path.join(dir, '.shapewall'),
    environments: [
      { id: 'local', baseUrl: `http://127.0.0.1:${first.address().port}` },
      { id: 'staging', baseUrl: `http://127.0.0.1:${second.address().port}` },
    ],
    auth: { loginScript: './login.mjs' },
    viewports: { desktop: { width: 1280, height: 800 } },
    pages: [{ id: 'home', path: '/', title: 'Home' }],
  }
  config = normalizeConfig(raw, { dir, file: path.join(dir, 'shapewall.config.json') })
})

after(async () => {
  await close(first)
  await close(second)
})

test('capture --env gives the login script that environment, and the default capture the first', async () => {
  const staged = await runCapture({ config, envId: 'staging', log: () => {} })
  assert.equal(staged.failed, 0)
  const local = await runCapture({ config, log: () => {} })
  assert.equal(local.failed, 0)
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), [
    `http://127.0.0.1:${second.address().port}`,
    `http://127.0.0.1:${first.address().port}`,
  ])
})
