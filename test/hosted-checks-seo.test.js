// The SEO tab on a hosted board: GET boards/:bid/checks/seo answers in the
// local route's shape with no search previews (they never leave the
// installation that ran the checks), instead of the 404 every hosted board
// load with checks open used to get. Unknown environments and reports still 404.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { main } from '../src/cli.js'
import { createBrowser, createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

let hosted
let owner
let base

before(async () => {
  hosted = await startHostedServer('hosted-checks-seo')
  owner = await signUp(hosted, { handle: 'olive', displayName: 'Olive' })
  const project = await createProject(owner, owner.workspaceId, 'Lumen')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const dir = tempDir('hosted-checks-seo-site')
  const configFile = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(configFile, JSON.stringify(structuredClone(SAMPLE)))
  const { loadConfig } = await import('../src/config.js')
  writeLocalCaptures(loadConfig(configFile), 'sample')
  const saved = process.env.SHAPEWALL_TOKEN
  process.env.SHAPEWALL_TOKEN = token
  try {
    const code = await main(['push', '--remote', hosted.origin, '--config', configFile], { out: () => {}, err: () => {} })
    assert.equal(code, 0)
  } finally {
    if (saved === undefined) delete process.env.SHAPEWALL_TOKEN
    else process.env.SHAPEWALL_TOKEN = saved
  }
  base = `/w/${owner.workspaceId}/p/${project.id}/api/boards/sample`
})
after(() => hosted?.close())

test('a hosted board answers the SEO tab with no search previews, in the local shape', async () => {
  const seo = await owner.browser.get(`${base}/checks/seo`)
  assert.equal(seo.status, 200)
  assert.equal(seo.headers['cache-control'], 'no-store')
  const checks = await owner.browser.get(`${base}/checks`)
  assert.equal(checks.status, 200)
  assert.deepEqual(seo.json, { schemaVersion: 1, environment: checks.json.environment, privatePages: [], snapshots: {} })

  const env = checks.json.environment
  assert.equal((await owner.browser.get(`${base}/checks/seo?env=${env}`)).status, 200)
  assert.equal((await owner.browser.get(`${base}/checks/seo?env=no-such-env`)).status, 404)
})

test('other check routes are unchanged: unknown reports 404, signed out 401', async () => {
  const missing = await owner.browser.get(`${base}/checks/no-such-report`)
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.message, 'Check report not found.')
  const anonymous = await createBrowser(hosted.port, hosted.origin).get(`${base}/checks/seo`)
  assert.equal(anonymous.status, 401)
})
