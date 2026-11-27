// Journey editing on the solo engine (G5): src/hosted/solo/journeys.js. The
// owner makes, changes and removes the board's own journeys with the same
// validation as a local board; they live in journeys.json in the engine's
// board folder. Journeys from the config file stay read only. A team server
// keeps journeys read only.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { projectDir } from '../src/hosted/projects.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { SAMPLE, tempDir } from './helpers.js'
import { createBrowser, createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'

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

test('rev58 G5-1: a whole push to the engine keeps the journeys made on the board', async () => {
  const { hosted, browser, owner, base, config } = await startSolo('solo-journeys-push')
  const token = await createToken({ browser }, owner.workspaceId, owner.projectId)
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const push = async () => {
    writeLocalCaptures(config, 'sample')
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    return remote.commitPush(started.id, { manifest, variants: [] })
  }
  await push()
  const made = await browser.post(`${base}/boards/sample/journeys`, { name: 'Upgrade', steps: ['home', 'pricing'] })
  assert.equal(made.status, 201, made.text)
  const file = path.join(projectDir(hosted.dataDir, owner.workspaceId, owner.projectId), 'sample', 'journeys.json')
  const before = fs.readFileSync(file, 'utf8')
  await push()
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file came across the swap byte for byte')
  assert.deepEqual(
    (await browser.get(`${base}/boards/sample/journeys`)).json.journeys.map((item) => item.id),
    ['upgrade'],
  )
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.carrying')),
    [],
  )
  // Still editable after the push, and a second push keeps the change.
  const renamed = await browser.call('PATCH', `${base}/boards/sample/journeys/upgrade`, { body: { name: 'Upgrade to Plus' } })
  assert.equal(renamed.status, 200, renamed.text)
  await push()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).journeys[0].name, 'Upgrade to Plus')
  // rev58 RR1-L3: a journeys.json that cannot be carried refuses the commit instead of being dropped.
  // A link in its place is never followed into the board, and the board stays as it was.
  const kept = fs.readFileSync(file)
  const refused = async () => {
    await assert.rejects(push(), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'board_local_unreadable')
      return true
    })
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.carrying')),
      [],
    )
  }
  fs.rmSync(file)
  const elsewhere = path.join(tempDir('solo-journeys-push-link'), 'journeys.json')
  fs.writeFileSync(elsewhere, JSON.stringify({ journeys: [{ id: 'planted', name: 'Planted', steps: ['home', 'app'] }] }))
  fs.symlinkSync(elsewhere, file)
  await refused()
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'the board folder was not swapped')
  // Too large to carry.
  fs.rmSync(file)
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))
  await refused()
  // rev58 RR1-L2: a FIFO never blocks the commit inside the write lock; it is refused at once.
  if (process.platform !== 'win32') {
    fs.rmSync(file)
    execFileSync('mkfifo', [file])
    const at = Date.now()
    await refused()
    assert.ok(Date.now() - at < 5000, 'the commit did not wait on the FIFO')
  }
  // Put right, the push goes through and the journeys come across.
  fs.rmSync(file)
  fs.writeFileSync(file, kept)
  await push()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).journeys[0].name, 'Upgrade to Plus')
})

// rev58 G5-1 residual race: a journey write while a whole push of that board commits. The commit (carry
// and swap) runs in one synchronous step inside the write lock, and a journey write reads, changes and
// writes journeys.json in one synchronous step inside its file lock, so in the engine one always lands
// wholly before or after the other: no write goes into the folder being swapped away.
test('rev58 G5-1: journey writes racing whole pushes are never lost', async () => {
  const { hosted, browser, owner, base, config } = await startSolo('solo-journeys-push-race')
  const token = await createToken({ browser }, owner.workspaceId, owner.projectId)
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  writeLocalCaptures(config, 'sample')
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  const ready = async () => {
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    return started.id
  }
  await remote.commitPush(await ready(), { manifest, variants: [] })
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']
  for (const name of names) {
    const id = await ready()
    const [made] = await Promise.all([
      browser.post(`${base}/boards/sample/journeys`, { name, steps: ['home', 'pricing'] }),
      remote.commitPush(id, { manifest, variants: [] }),
    ])
    assert.equal(made.status, 201, made.text)
  }
  const listed = (await browser.get(`${base}/boards/sample/journeys`)).json.journeys.map((item) => item.name)
  assert.deepEqual(listed.sort(), [...names].sort())
  const folder = path.join(projectDir(hosted.dataDir, owner.workspaceId, owner.projectId), 'sample')
  assert.deepEqual(
    fs.readdirSync(folder).filter((name) => name.includes('.lock') || name.endsWith('.carrying')),
    [],
  )
})
