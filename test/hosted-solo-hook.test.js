// The solo profile's hook (src/hosted/solo/index.js): createHostedApp({ solo })
// mounts the solo surfaces once and gives them a router inside the members'
// board API that answers before its catch-all; a team server (no `solo`)
// mounts nothing and has no such router.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createBrowser, createProject, signUp, startHostedServer } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

async function start(name, options) {
  const hosted = await startHostedServer(name, options)
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Solo hook')
  return { hosted, owner, base: `/w/${owner.workspaceId}/p/${project.id}/api`, project }
}

test('a team server mounts no solo surfaces and has no solo board router', async () => {
  const { hosted, owner, base } = await start('solo-hook-team')
  assert.equal(hosted.app.locals.soloBoardApi, null)
  const probe = await owner.browser.get(`${base}/solo-probe`)
  assert.equal(probe.status, 404)
  assert.equal(probe.json.error.message, 'No such API route.')
})

test('a solo server gives its surfaces a members-only board router before the catch-all', async () => {
  const { hosted, owner, base, project } = await start('solo-hook-solo', { solo: {} })
  const router = hosted.app.locals.soloBoardApi
  assert.equal(typeof router, 'function')
  router.get('/solo-probe', (req, res) => res.json({ role: req.role, project: req.project.id }))

  const probe = await owner.browser.get(`${base}/solo-probe`)
  assert.equal(probe.status, 200)
  assert.deepEqual(probe.json, { role: 'owner', project: project.id })

  // The board API's session check runs first: no cookie, no route.
  const anonymous = await createBrowser(hosted.port, hosted.origin).get(`${base}/solo-probe`)
  assert.equal(anonymous.status, 401)

  // The rest of the board API is unchanged.
  const info = await owner.browser.get(`${base}/info`)
  assert.equal(info.status, 200)
  assert.equal(info.json.hosted, true)
  const other = await owner.browser.get(`${base}/no-such-route`)
  assert.equal(other.status, 404)
})
