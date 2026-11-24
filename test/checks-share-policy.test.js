import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { saveReport } from '../src/checks/store.js'
import { portableChecks } from '../src/checks/transport.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createBrowser, createProject, createToken, reauth, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'
import { checkReport } from './checks-fixture.js'

test('check sharing requires a boolean creator opt-in and rechecks every guest authorization boundary', async (t) => {
  const hosted = await startHostedServer('checks-share-policy', { signup: 'open' })
  t.after(() => hosted.close())
  const owner = await signUp(hosted, { handle: 'checks-sharing' })
  const project = await createProject(owner, owner.workspaceId, 'Private checks')
  const otherProject = await createProject(owner, owner.workspaceId, 'Other project')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const config = normalizeConfig(structuredClone(SAMPLE), { dir: tempDir('checks-share-fixture') })
  const board = config.boards[0]
  writeLocalCaptures(config, board.id)
  const report = await saveReport(config, checkReport(config))
  const remote = createRemote({ origin: hosted.origin, token })
  const push = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(push.id, area, name, fs.readFileSync(file))
  await remote.commitPush(push.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, board.id, 'captures', 'manifest.json'))),
    variants: [],
    checks: portableChecks(config, board, { includeChecks: true }),
  })
  await reauth(owner)
  await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: true } })
  const shareBase = `/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares`
  for (const includeChecks of ['true', 1, null, {}]) assert.equal((await owner.browser.post(shareBase, { includeChecks })).status, 400)
  async function link(includeChecks, projectId = project.id) {
    const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${projectId}/shares`, {
      mode: 'view',
      ...(includeChecks === undefined ? {} : { includeChecks }),
    })
    assert.equal(made.status, 201, made.text)
    const guest = createBrowser(hosted.port, hosted.origin)
    assert.equal(
      (await guest.post(`/s/${made.json.share.id}/open`, { token: new URL(made.json.url, hosted.origin).hash.slice(1) })).status,
      200,
    )
    return { guest, id: made.json.share.id, share: made.json.share, root: `/s/${made.json.share.id}/api` }
  }
  const hidden = await link()
  const visible = await link(true)
  const other = await link(true, otherProject.id)
  const checks = `/boards/${board.id}/checks`
  assert.equal(hidden.share.includeChecks, false)
  assert.equal((await hidden.guest.get(`${hidden.root}/info`)).json.checksAvailable, false)
  assert.equal((await hidden.guest.get(`${hidden.root}${checks}`)).status, 404)
  assert.equal((await hidden.guest.get(`${hidden.root}${checks}/${report.id}`)).status, 404)
  assert.equal((await visible.guest.get(`${visible.root}/info`)).json.checksAvailable, true)
  assert.equal((await visible.guest.get(`${visible.root}${checks}`)).json.checked, 1)
  assert.equal((await visible.guest.get(`${visible.root}${checks}/${report.id}`)).json.report.id, report.id)
  assert.equal((await other.guest.get(`${other.root}${checks}`)).status, 404)
  assert.equal((await hidden.guest.get(`${visible.root}${checks}`)).status, 401, 'a different link cookie grants no access')
  assert.equal((await createBrowser(hosted.port, hosted.origin).get(`${visible.root}${checks}`)).status, 401)
  assert.equal((await visible.guest.post(`${visible.root}${checks}`, {})).status, 404, 'reports never authorize a run')
  await owner.browser.call('DELETE', `${shareBase}/${visible.id}`)
  assert.equal((await visible.guest.get(`${visible.root}${checks}/${report.id}`)).status, 401, 'revocation affects an already open guest')
  const disabled = await link(true)
  await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: false } })
  assert.equal((await disabled.guest.get(`${disabled.root}${checks}`)).status, 401)
  assert.equal((await owner.browser.get(`/w/${owner.workspaceId}/p/${project.id}/api${checks}`)).json.checked, 1)
})
