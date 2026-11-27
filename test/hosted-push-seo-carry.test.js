// A whole push carries a board's search previews (checks/seo/<report>.json,
// written only by a checks run on the server, src/checks/seo-snapshot.js)
// across the folder swap, as it carries journeys.json (src/hosted/push.js
// BOARD_LOCAL_FILES): one per report the push keeps, never a link.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { saveReport } from '../src/checks/store.js'
import { portableChecks } from '../src/checks/transport.js'
import { projectDir } from '../src/hosted/projects.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'
import { checkReport } from './checks-fixture.js'

test('a whole push keeps the kept reports’ search previews, drops an orphan one and never follows a link', async (t) => {
  const hosted = await startHostedServer('seo-carry', { signup: 'open' })
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'seo-carry-owner' })
  const project = await createProject(owner, owner.workspaceId, 'SEO carry')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const config = normalizeConfig(structuredClone(SAMPLE), { dir: tempDir('seo-carry') })
  const board = config.boards[0]
  writeLocalCaptures(config, board.id)
  await saveReport(config, checkReport(config))
  const checks = portableChecks(config, board, { includeChecks: true })
  const reportId = checks.reports[0].id
  async function push(bundle) {
    const start = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, board.id, 'captures', 'manifest.json')))
    return remote.commitPush(start.id, { manifest, variants: [], ...(bundle !== undefined ? { checks: bundle } : {}) })
  }
  await push(checks)
  const folder = path.join(projectDir(hosted.dataDir, owner.workspaceId, project.id), board.id)
  const seoDir = path.join(folder, 'checks', 'seo')
  // As a checks run on the server leaves them: one for the kept report, one for a report the board no longer has.
  fs.mkdirSync(seoDir, { recursive: true })
  const preview = path.join(seoDir, `${reportId}.json`)
  fs.writeFileSync(preview, JSON.stringify({ boardId: board.id, reportId, marker: 'kept' }))
  const orphan = path.join(seoDir, 'check-00000000-0000-4000-8000-000000000000.json')
  fs.writeFileSync(orphan, '{}')
  const before = fs.readFileSync(preview, 'utf8')

  // A push without checks keeps the stored report, so its preview too.
  await push()
  assert.equal(fs.readFileSync(preview, 'utf8'), before, 'the preview came across the swap byte for byte')
  assert.equal(fs.existsSync(orphan), false, 'a preview without a kept report is not carried')
  assert.deepEqual(
    fs.readdirSync(seoDir).filter((name) => name.endsWith('.carrying')),
    [],
  )
  // A push with the same report keeps it as well.
  await push(checks)
  assert.equal(fs.readFileSync(preview, 'utf8'), before)

  // A link in the preview's place, or in the folder's, is never followed into the board.
  const elsewhere = tempDir('seo-carry-link')
  fs.writeFileSync(path.join(elsewhere, `${reportId}.json`), JSON.stringify({ planted: true }))
  fs.rmSync(preview)
  fs.symlinkSync(path.join(elsewhere, `${reportId}.json`), preview)
  await push()
  assert.equal(fs.existsSync(preview), false, 'a linked preview is not carried')
  fs.rmSync(seoDir, { recursive: true, force: true })
  fs.symlinkSync(elsewhere, seoDir)
  await push()
  assert.equal(fs.existsSync(preview), false, 'a linked previews folder is not followed')
})
