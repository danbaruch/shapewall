// Self-update on the solo engine (src/hosted/solo/update.js, G10): the same
// router as local serve (src/update/routes.js), at the solo board's
// api/app-update, for the engine's signed-in owner on this machine only. A
// team server has no such route.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createBrowser, createProject, invite, signUp, startHostedServer } from './hosted-helpers.js'
import { tempDir } from './helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

function helper(source) {
  const dir = tempDir('solo-update-helper')
  const file = path.join(dir, 'update')
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  return file
}
const answer = (extra = {}) => JSON.stringify({ latest: { version: '9.9.9', revision: 'abcdef1234567' }, updateAvailable: true, ...extra })

async function start(name, options) {
  const hosted = await startHostedServer(name, options)
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Solo update')
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  return { hosted, owner, base, url: `${base}/app-update` }
}

async function settled(browser, url) {
  for (let i = 0; i < 300; i++) {
    const response = await browser.get(url)
    if (response.json.job?.state !== 'running') return response.json
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Update helper did not finish')
}

test('a team server has no app-update route and no appUpdates feature', async () => {
  const { owner, base, url } = await start('solo-update-team')
  const status = await owner.browser.get(url)
  assert.equal(status.status, 404)
  const check = await owner.browser.post(`${url}/check`, {})
  assert.equal(check.status, 404)
  const info = await owner.browser.get(`${base}/info`)
  assert.equal('soloFeatures' in info.json, false)
})

test('without an installer helper the engine reports manual updates and never runs one', async () => {
  const { owner, base, url } = await start('solo-update-manual', { solo: { env: {} } })
  const info = await owner.browser.get(`${base}/info`)
  assert.equal(info.json.soloFeatures.appUpdates, true)
  const status = await owner.browser.get(url)
  assert.equal(status.status, 200)
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.equal(status.json.supported, false)
  assert.equal(status.json.canUpdate, false)
  assert.match(status.json.reason, /managed by the person who installed/)
  assert.equal(status.json.current.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  const check = await owner.browser.post(`${url}/check`, {})
  assert.equal(check.status, 503)
  assert.equal(check.json.error.code, 'update_unsupported')
})

test('the owner on this machine checks and applies; the helper sees only the fixed action', async () => {
  const log = path.join(tempDir('solo-update-log'), 'calls')
  const file = helper(`
    import fs from 'node:fs'
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
    console.log(${JSON.stringify(answer({ restartRequired: true }))})
  `)
  let restarts = 0
  const { hosted, owner, url } = await start('solo-update-owner', {
    solo: { env: {}, appUpdate: { helper: file, restartDelayMs: 0, onRestart: () => restarts++ } },
  })
  const before = await owner.browser.get(url)
  assert.equal(before.json.supported, true)
  assert.equal(before.json.canUpdate, true)
  assert.equal(before.json.reason, null)

  // Apply before a positive check is refused.
  const early = await owner.browser.post(`${url}/apply`, {})
  assert.equal(early.status, 409)
  assert.equal(early.json.error.code, 'update_not_available')

  const check = await owner.browser.post(`${url}/check`, {})
  assert.equal(check.status, 202)
  const checked = await settled(owner.browser, url)
  assert.equal(checked.job.state, 'succeeded')
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.latest.version, '9.9.9')
  assert.equal(restarts, 0, 'a check never restarts')

  const apply = await owner.browser.post(`${url}/apply`, {})
  assert.equal(apply.status, 202)
  assert.equal(hosted.app.locals.appUpdate.applying(), true)
  const applied = await settled(owner.browser, url)
  assert.equal(applied.job.state, 'succeeded')
  await hosted.app.locals.appUpdate.settled()
  for (let i = 0; i < 100 && !restarts; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(restarts, 1, 'the installer opted in to a restart after a successful apply')
  assert.deepEqual(
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [['check'], ['apply']],
  )

  // A body is refused, as on a local board.
  const body = await owner.browser.post(`${url}/check`, { action: 'apply' })
  assert.equal(body.status, 400)
})

test('only the owner, on this machine, from the board page, may check or apply', async () => {
  const file = helper(`console.log(${JSON.stringify(answer())})`)
  const { hosted, owner, url } = await start('solo-update-who', { solo: { env: {}, appUpdate: { helper: file } } })

  // No session: the board API refuses before the update router.
  const anonymous = createBrowser(hosted.port, hosted.origin)
  assert.equal((await anonymous.get(url)).status, 401)
  assert.equal((await anonymous.post(`${url}/check`, {})).status, 401)

  // A member (a solo engine has none, but the role check holds).
  const memberInvite = await invite(owner, owner.workspaceId, 'member')
  const member = await signUp(hosted, { handle: 'member', invite: memberInvite })
  const memberStatus = await member.browser.get(url)
  assert.equal(memberStatus.status, 200)
  assert.equal(memberStatus.json.canUpdate, false)
  const memberCheck = await member.browser.post(`${url}/check`, {})
  assert.equal(memberCheck.status, 403)
  assert.equal(memberCheck.json.error.code, 'update_forbidden')

  // Through a proxy or tunnel (proxy headers): not this machine.
  for (const header of ['X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded']) {
    const proxied = await owner.browser.post(`${url}/check`, {}, { headers: { [header]: '203.0.113.9' } })
    assert.equal(proxied.status, 403, header)
    assert.equal(proxied.json.error.code, 'update_forbidden', header)
    const status = await owner.browser.get(url, { headers: { [header]: '203.0.113.9' } })
    assert.equal(status.json.canUpdate, false, header)
  }

  // Another site's page (cross-origin write) is refused: either by the
  // engine's own write guard or by the update router.
  const crossSite = await owner.browser.post(`${url}/check`, {}, { headers: { Origin: 'http://evil.example' } })
  assert.equal(crossSite.status, 403)
  // No Origin at all (not from the board page).
  const noOrigin = await owner.browser.post(`${url}/check`, {}, { sendOrigin: false })
  assert.equal(noOrigin.status, 403)

  // Nothing ran.
  const after = await owner.browser.get(url)
  assert.equal(after.json.job, null)
})

test('a read-only engine shows the version but cannot check or apply', async () => {
  const file = helper(`console.log(${JSON.stringify(answer())})`)
  const { owner, url } = await start('solo-update-read-only', { solo: { env: {}, readOnly: true, appUpdate: { helper: file } } })
  const status = await owner.browser.get(url)
  assert.equal(status.json.canUpdate, false)
  assert.equal(status.json.reason, 'This board is read-only.')
  const check = await owner.browser.post(`${url}/check`, {})
  assert.equal(check.status, 403)
  assert.equal(check.json.error.code, 'read_only')
})

test('stopping the engine waits for an apply and never kills it', async () => {
  const marker = path.join(tempDir('solo-update-slow'), 'done')
  const file = helper(`
    import fs from 'node:fs'
    if (process.argv[2] === 'apply') await new Promise((resolve) => setTimeout(resolve, 400))
    if (process.argv[2] === 'apply') fs.writeFileSync(${JSON.stringify(marker)}, 'ok')
    console.log(${JSON.stringify(answer())})
  `)
  const hosted = await startHostedServer('solo-update-stop', { solo: { env: {}, appUpdate: { helper: file } } })
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Solo update stop')
  const url = `/w/${owner.workspaceId}/p/${project.id}/api/app-update`
  assert.equal((await owner.browser.post(`${url}/check`, {})).status, 202)
  await settled(owner.browser, url)
  assert.equal((await owner.browser.post(`${url}/apply`, {})).status, 202)
  assert.equal(hosted.app.locals.appUpdate.applying(), true)
  await hosted.close()
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ok', 'close returned only after the apply finished')
})
