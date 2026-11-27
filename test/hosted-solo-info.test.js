// The solo engine's board /info (src/hosted/solo/info.js, G16): a solo server
// adds `solo: true` and `soloFeatures` to the members' /info; a team server
// never sends either, so the board keeps every hosted behaviour there.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createBrowser, createProject, invite, signUp, startHostedServer } from './hosted-helpers.js'
import { SOLO_FEATURES, hostedOrSolo, soloOwner } from '../client/src/board/solo.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

async function start(name, options) {
  const hosted = await startHostedServer(name, options)
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Solo info')
  return { hosted, owner, base: `/w/${owner.workspaceId}/p/${project.id}/api` }
}

test('a team server never sends solo or soloFeatures on its board /info', async () => {
  const { hosted, owner, base } = await start('solo-info-team')
  const info = await owner.browser.get(`${base}/info`)
  assert.equal(info.status, 200)
  assert.equal(info.json.hosted, true)
  assert.equal(info.json.role, 'owner')
  assert.equal('solo' in info.json, false)
  assert.equal('soloFeatures' in info.json, false)
  // So the board keeps the team behaviour at every local-only call site.
  assert.equal(soloOwner(info.json), false)
  for (const feature of SOLO_FEATURES) assert.equal(hostedOrSolo(info.json, feature), false, feature)

  const memberInvite = await invite(owner, owner.workspaceId, 'member')
  const member = await signUp(hosted, { handle: 'member', invite: memberInvite })
  const memberInfo = await member.browser.get(`${base}/info`)
  assert.equal(memberInfo.status, 200)
  assert.equal('solo' in memberInfo.json, false)
})

test('a solo server adds solo and its features to the members /info only', async () => {
  const { hosted, owner, base } = await start('solo-info-solo', { solo: {} })
  const info = await owner.browser.get(`${base}/info`)
  assert.equal(info.status, 200)
  assert.equal(info.json.hosted, true)
  assert.equal(info.json.solo, true)
  assert.equal(typeof info.json.soloFeatures, 'object')
  assert.equal(soloOwner(info.json), true)
  // The rest of /info is the team one.
  assert.equal(info.json.role, 'owner')
  assert.equal(info.json.allowCapture, false)
  assert.ok(info.json.project?.url)

  // No session, no /info (the board API's session check runs first).
  const anonymous = await createBrowser(hosted.port, hosted.origin).get(`${base}/info`)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json?.solo, undefined)
})
