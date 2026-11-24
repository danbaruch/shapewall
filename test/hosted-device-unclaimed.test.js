// A device login approved in the console whose terminal never polls: the API
// token made for it is revoked when the login goes, not left live with no holder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEVICE_TTL_MS } from '../src/hosted/device.js'
import { createBrowser, createProject, signUp, startHostedServer } from './hosted-helpers.js'

function clock() {
  let offset = 0
  return { now: () => new Date(Date.now() + offset), advance: (ms) => (offset += ms) }
}

test('an approved device login nobody collects has its token revoked; a collected one keeps it', async () => {
  const time = clock()
  const hosted = await startHostedServer('device-unclaimed', { now: time.now })
  try {
    const owner = await signUp(hosted, { handle: 'dora' })
    const project = await createProject(owner, owner.workspaceId, 'Devices')
    const cli = createBrowser(hosted.port, hosted.origin)
    const login = async () => {
      const started = await cli.post('/api/v1/device/start', { name: 'Laptop' })
      assert.equal(started.status, 201, started.text)
      const approved = await owner.browser.post('/api/device/approve', {
        code: started.json.userCode,
        workspaceId: owner.workspaceId,
        projectId: project.id,
        scopes: ['read'],
      })
      assert.equal(approved.status, 200, approved.text)
      return { deviceCode: started.json.deviceCode, tokenId: approved.json.info.id }
    }
    const revokedAt = (id) => hosted.db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id).revoked_at
    const collected = await login()
    const polled = await cli.post('/api/v1/device/poll', { deviceCode: collected.deviceCode })
    assert.equal(polled.json.status, 'approved')
    const abandoned = await login()
    assert.equal(revokedAt(abandoned.tokenId), null, 'live while its terminal may still poll')
    // The login expires unpolled; the next login (any start or poll) sweeps it.
    time.advance(DEVICE_TTL_MS + 1000)
    await cli.post('/api/v1/device/start', { name: 'Other' })
    assert.ok(revokedAt(abandoned.tokenId), 'the orphan token is revoked')
    assert.equal(revokedAt(collected.tokenId), null, 'the token its terminal collected stays live')
    assert.equal((await cli.post('/api/v1/device/poll', { deviceCode: abandoned.deviceCode })).status, 410)
  } finally {
    await hosted.close()
  }
})
