// Journey editing on the solo engine (G5): src/hosted/solo/journeys.js. The
// owner makes, changes and removes the board's own journeys with the same
// validation as a local board; they live in journeys.json in the engine's
// board folder. Journeys from the config file stay read only. A team server
// keeps journeys read only.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { projectDir } from '../src/hosted/projects.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { SAMPLE, tempDir } from './helpers.js'
import { createBrowser, createProject, signUp, startHostedServer } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

function projectConfig(name, overrides = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), ...overrides }, null, 2))
  return loadConfig(file)
}

async function startSolo(name, { solo = {}, config = projectConfig(`${name}-project`) } = {}) {
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester', ...solo },
  })
  servers.push(hosted)
  const browser = createBrowser(hosted.port, hosted.origin)
  const file = hosted.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  const opened = await browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(opened.status, 200)
  const { owner } = hosted.app.locals.solo
  return { hosted, browser, owner, base: `/w/${owner.workspaceId}/p/${owner.projectId}/api`, config }
}

test('a team server keeps journeys read only and never lists the journeys feature', async () => {
  const hosted = await startHostedServer('solo-journeys-team')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Team')
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  const made = await owner.browser.post(`${base}/boards/sample/journeys`, { name: 'Upgrade', steps: ['home', 'pricing'] })
  assert.equal(made.status, 403)
  assert.equal(made.json.error.code, 'hosted_journeys')
  assert.equal('soloFeatures' in (await owner.browser.get(`${base}/info`)).json, false)
})

test('the owner makes, changes and removes a journey; it lands in the engine’s board folder and in the board view', async () => {
  const { hosted, browser, owner, base } = await startSolo('solo-journeys-owner')
  const info = await browser.get(`${base}/info`)
  assert.equal(info.json.soloFeatures.journeys, true)

  const made = await browser.post(`${base}/boards/sample/journeys`, { name: 'Upgrade to Plus', steps: ['home', 'pricing'] })
  assert.equal(made.status, 201, made.text)
  assert.equal(made.json.journey.id, 'upgrade-to-plus')
  assert.equal(made.json.journey.source, 'board')
  const file = path.join(projectDir(hosted.dataDir, owner.workspaceId, owner.projectId), 'sample', 'journeys.json')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).journeys.map((item) => item.steps),
    [['home', 'pricing']],
  )
  const view = await browser.get(`${base}/boards/sample`)
  assert.deepEqual(
    view.json.journeys.map((item) => [item.id, item.source]),
    [['upgrade-to-plus', 'board']],
  )
  const listed = await browser.get(`${base}/boards/sample/journeys`)
  assert.equal(listed.json.journeys.length, 1)

  const changed = await browser.call('PATCH', `${base}/boards/sample/journeys/upgrade-to-plus`, {
    body: { name: 'Upgrade', steps: ['home', 'pricing', 'app'], description: 'From the landing page' },
  })
  assert.equal(changed.status, 200, changed.text)
  assert.deepEqual(changed.json.journey.steps, ['home', 'pricing', 'app'])
  assert.equal(changed.json.journey.description, 'From the landing page')

  const removed = await browser.call('DELETE', `${base}/boards/sample/journeys/upgrade-to-plus`)
  assert.equal(removed.status, 200)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).journeys, [])
  assert.equal((await browser.call('DELETE', `${base}/boards/sample/journeys/upgrade-to-plus`)).status, 404)
})

test('the same validation as local: unknown pages, one step, config journeys and the file’s current pages', async () => {
  const config = projectConfig('solo-journeys-rules-project', {
    journeys: [{ id: 'signup', name: 'Sign up', steps: ['home', 'app'] }],
  })
  const { browser, base } = await startSolo('solo-journeys-rules', { config })
  const bad = async (body, code, status = 400) => {
    const response = await browser.post(`${base}/boards/sample/journeys`, body)
    assert.equal(response.status, status, `${JSON.stringify(body)} ${response.text}`)
    assert.equal(response.json.error.code, code)
  }
  await bad({ name: 'Nowhere', steps: ['home', 'nope'] }, 'invalid_journey')
  await bad({ name: 'Short', steps: ['home'] }, 'invalid_journey')
  await bad({ steps: ['home', 'pricing'] }, 'invalid_journey')
  await bad({}, 'invalid_journey')
  // A config journey is read only here, and a new one never takes its id.
  const edit = await browser.call('PATCH', `${base}/boards/sample/journeys/signup`, { body: { name: 'x' } })
  assert.equal(edit.status, 409)
  assert.equal(edit.json.error.code, 'config_journey')
  assert.equal((await browser.call('DELETE', `${base}/boards/sample/journeys/signup`)).status, 409)
  const twin = await browser.post(`${base}/boards/sample/journeys`, { name: 'Signup', steps: ['home', 'pricing'] })
  assert.equal(twin.status, 201)
  assert.notEqual(twin.json.journey.id, 'signup')
  // The file drops a page: steps are checked against the file as it is now.
  const raw = JSON.parse(fs.readFileSync(config.file, 'utf8'))
  fs.writeFileSync(config.file, JSON.stringify({ ...raw, pages: raw.pages.filter((page) => page.id !== 'pricing') }, null, 2))
  await bad({ name: 'Old', steps: ['home', 'pricing'] }, 'invalid_journey')
  assert.equal((await browser.post(`${base}/boards/other/journeys`, { name: 'X', steps: ['home', 'app'] })).status, 404)
})

test('only the owner, on this machine: no session, a proxy header, another Host or a cross-site page are refused; --read-only edits nothing', async () => {
  const { hosted, browser, base } = await startSolo('solo-journeys-who')
  const body = { name: 'Upgrade', steps: ['home', 'pricing'] }
  assert.equal((await createBrowser(hosted.port, hosted.origin).post(`${base}/boards/sample/journeys`, body)).status, 401)
  const proxied = await browser.post(`${base}/boards/sample/journeys`, body, { headers: { 'X-Forwarded-For': '10.0.0.9' } })
  assert.ok([401, 403].includes(proxied.status), proxied.text)
  const cross = await browser.post(`${base}/boards/sample/journeys`, body, { headers: { Origin: 'http://evil.example' } })
  assert.equal(cross.status, 403)
  const otherHost = await browser.post(`${base}/boards/sample/journeys`, body, { headers: { Host: `localhost:${hosted.port}` } })
  assert.ok([401, 403].includes(otherHost.status), otherHost.text)
  assert.equal((await browser.get(`${base}/boards/sample`)).json.journeys.length, 0)

  const readOnly = await startSolo('solo-journeys-ro', { solo: { readOnly: true } })
  const refused = await readOnly.browser.post(`${readOnly.base}/boards/sample/journeys`, body)
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'read_only')
  assert.notEqual((await readOnly.browser.get(`${readOnly.base}/info`)).json.soloFeatures?.journeys, true)
})
