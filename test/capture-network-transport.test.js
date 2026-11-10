import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { readManifest } from '../src/store.js'
import { exportStatic } from '../src/export.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

const summary = {
  schemaVersion: 1,
  window: 'navigation-through-screenshot',
  responses: 6,
  http4xx: 1,
  http5xx: 1,
  apiErrors: 2,
  rateLimited: 1,
  apiRateLimited: 1,
  failedRequests: 1,
  capped: false,
}
function fixture() {
  const config = normalizeConfig(structuredClone(SAMPLE), { dir: tempDir('capture-network-transfer') })
  writeLocalCaptures(config, config.boards[0].id)
  const file = path.join(config.outputDir, config.boards[0].id, 'captures', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file))
  manifest.pages.home.desktop.networkSummary = {
    ...summary,
    url: 'https://private.invalid/api?token=fixture-secret',
    body: 'fixture-body-secret',
    headers: { authorization: 'fixture-token-secret' },
  }
  manifest.pages.home.desktop.httpStatus = 404
  manifest.pages.home.desktop.expectedStatus = true
  manifest.pages.home.phone.networkSummary = { ...summary, rateLimited: '429' }
  fs.writeFileSync(file, JSON.stringify(manifest))
  return { config, manifest }
}

test('stored and statically exported network summaries discard unknown private fields and invalid counts', async () => {
  const { config } = fixture()
  const clean = readManifest(config, config.boards[0].id)
  assert.deepEqual(clean.pages.home.desktop.networkSummary, summary)
  assert.equal(clean.pages.home.phone.networkSummary, undefined)
  const clientDir = path.join(config.dir, 'client')
  fs.mkdirSync(clientDir)
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<html><head></head></html>')
  const out = path.join(config.dir, 'export')
  await exportStatic(config, { out, clientDir })
  const view = JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', `${config.boards[0].id}.json`)))
  assert.deepEqual(view.manifest.pages.home.desktop.networkSummary, summary)
  assert.equal(view.manifest.pages.home.phone.networkSummary, undefined)
  assert.doesNotMatch(JSON.stringify(view), /fixture-.*secret|private.invalid/)
})

test('actual hosted push preserves usable capture warnings and expected statuses through a strict aggregate allowlist', async (t) => {
  const hosted = await startHostedServer('capture-network-hosted', { signup: 'open' })
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'capture-network-owner' })
  const project = await createProject(owner, owner.workspaceId, 'Capture network')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const { config, manifest } = fixture(),
    board = config.boards[0]
  const start = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
  await remote.commitPush(start.id, { manifest, variants: [] })
  const response = await owner.browser.get(`/w/${owner.workspaceId}/p/${project.id}/api/boards/${board.id}`)
  assert.equal(response.status, 200, response.text)
  const entry = response.json.manifest.pages.home.desktop
  assert.equal(entry.status, 'ok', 'network errors do not relabel the saved screenshot as failed')
  assert.deepEqual(entry.networkSummary, summary)
  assert.equal(entry.httpStatus, 404)
  assert.equal(entry.expectedStatus, true)
  assert.equal(response.json.manifest.pages.home.phone.networkSummary, undefined)
  assert.doesNotMatch(JSON.stringify(response.json), /fixture-.*secret|private.invalid/)
})
