// rev63 R1-L1: on the solo engine, the workspace the engine serves and the
// account that owns it cannot be deleted (src/hosted/solo/binding.js
// deletesSoloBinding, used by admin.js and auth-routes.js). Deleting them
// would leave the engine bound to nothing, and a capture or checks run going
// at that moment would write its files back under the removed folder. A team
// server deletes as before.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { projectDir } from '../src/hosted/projects.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { SAMPLE, tempDir } from './helpers.js'
import { createBrowser, signUp, startHostedServer } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

async function startSolo(name) {
  const dir = tempDir(`${name}-project`)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(structuredClone(SAMPLE), null, 2))
  const config = loadConfig(file)
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester' },
  })
  servers.push(hosted)
  const browser = createBrowser(hosted.port, hosted.origin)
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(hosted.app.locals.soloOpenFile(), 'utf8'))[1]
  const opened = await browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(opened.status, 200)
  return { hosted, browser, owner: hosted.app.locals.solo.owner }
}

const confirmed = (phrase) => ({ 'X-Shapewall-Confirm': encodeURIComponent(phrase) })

test('the solo engine refuses deleting its own workspace, even confirmed', async () => {
  const { hosted, browser, owner } = await startSolo('solo-delete-workspace')
  const workspace = hosted.db.prepare('SELECT name FROM workspaces WHERE id = ?').get(owner.workspaceId)
  const folder = projectDir(hosted.dataDir, owner.workspaceId, owner.projectId)
  fs.mkdirSync(folder, { recursive: true })
  const remove = await browser.call('DELETE', `/api/workspaces/${owner.workspaceId}`, {
    body: { confirm: workspace.name },
    headers: confirmed(workspace.name),
  })
  assert.equal(remove.status, 409, remove.text)
  assert.equal(remove.json.error.code, 'solo_workspace')
  assert.match(remove.json.error.message, /workspace the engine serves/)
  assert.ok(hosted.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(owner.workspaceId), 'the workspace is still there')
  assert.ok(fs.existsSync(folder), 'its files are still there')
})

test('the solo engine refuses deleting the owner’s account, even confirmed', async () => {
  const { hosted, browser, owner } = await startSolo('solo-delete-account')
  const user = hosted.db.prepare('SELECT handle FROM users WHERE id = ?').get(owner.userId)
  const remove = await browser.call('DELETE', '/auth/me', { body: { confirm: user.handle }, headers: confirmed(user.handle) })
  assert.equal(remove.status, 409, remove.text)
  assert.equal(remove.json.error.code, 'solo_owner')
  assert.ok(hosted.db.prepare('SELECT 1 FROM users WHERE id = ?').get(owner.userId), 'the account is still there')
  assert.ok(hosted.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(owner.workspaceId), 'the workspace is still there')
})

test('a team server deletes a workspace as before', async () => {
  const hosted = await startHostedServer('solo-delete-team')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'teamowner' })
  const workspace = hosted.db.prepare('SELECT name FROM workspaces WHERE id = ?').get(owner.workspaceId)
  const remove = await owner.browser.call('DELETE', `/api/workspaces/${owner.workspaceId}`, { body: { confirm: workspace.name } })
  assert.equal(remove.status, 200, remove.text)
  assert.equal(hosted.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(owner.workspaceId), undefined)
})
