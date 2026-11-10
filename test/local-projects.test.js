import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig, starterConfig } from '../src/config.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { writeServeState } from '../src/serve-state.js'
import { listLocalProjects, localProjectUrl, projectsFile, registerProject } from '../src/local-projects.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-projects-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'settings'), SHAPEWALL_AGENT_SETTINGS_FILE: '' }
  const project = (name) => {
    const root = path.join(dir, name)
    fs.mkdirSync(root)
    const file = path.join(root, 'shapewall.config.json')
    fs.writeFileSync(file, JSON.stringify({ ...starterConfig(), title: name }))
    return loadConfig(file)
  }
  return { dir, env, project }
}

test('local projects persist across servers, deduplicate, and distinguish running and stopped projects', async (t) => {
  const { env, project } = fixture(t)
  const first = project('Alpha')
  const second = project('Beta')
  registerProject(first, env)
  registerProject(second, env)
  registerProject(first, env)
  const app = createApp({ config: first, env, chat: false })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  t.after(async () => {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  })
  const url = `http://127.0.0.1:${server.address().port}/`
  writeServeState(first, url)
  const list = await listLocalProjects(first, env)
  assert.equal(list.length, 2)
  assert.deepEqual(
    list.map(({ title, current, running }) => ({ title, current, running })),
    [
      { title: 'Alpha', current: true, running: true },
      { title: 'Beta', current: false, running: false },
    ],
  )
  assert.equal(list[0].url, url)
  assert.ok(list.every((item) => !('file' in item) && !('dir' in item)))
  if (process.platform !== 'win32') assert.equal(fs.statSync(projectsFile(env)).mode & 0o777, 0o600)
  const raw = JSON.parse(fs.readFileSync(second.file))
  raw.title = 'Renamed Beta'
  fs.writeFileSync(second.file, JSON.stringify(raw))
  assert.equal((await listLocalProjects(first, env))[1].title, 'Renamed Beta')
  // A stale live PID or a reused port must not enable a dead/wrong project.
  writeServeState(second, url)
  const wrong = (await listLocalProjects(first, env))[1]
  assert.equal(wrong.running, false)
  assert.equal(wrong.url, null)
  await new Promise((resolve) => server.close(resolve))
  assert.equal((await listLocalProjects(first, env))[0].running, false)
  fs.unlinkSync(second.file)
  assert.equal((await listLocalProjects(first, env)).length, 1)
})

test('registry corruption and unsafe ownership are refused without overwriting existing data', async (t) => {
  const { env, project } = fixture(t)
  const config = project('Alpha')
  registerProject(config, env)
  const file = projectsFile(env)
  fs.writeFileSync(file, 'broken index')
  assert.throws(() => registerProject(config, env), /could not be read/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken index')
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o666)
    await assert.rejects(listLocalProjects(config, env), /owned and writable only by you/)
  }
})

test('project navigation refuses external, credential-bearing and token-bearing URLs', () => {
  for (const bad of [
    'https://example.com/',
    'http://127.0.0.1.evil.test/',
    'javascript:alert(1)',
    'http://user:pass@127.0.0.1:4600/',
    'http://127.0.0.1:4600/#settings-token=secret',
    'http://localhost:4600/open/nonce',
    'http://localhost:4600/?token=secret',
  ])
    assert.equal(localProjectUrl(bad), null)
  assert.equal(localProjectUrl('http://[::1]:4600/'), 'http://[::1]:4600/')
})

test('project list is host-only, refuses proxies and shared boards, and does not expose settings', async (t) => {
  const { env, project } = fixture(t)
  const config = project('Alpha')
  registerProject(config, env)
  for (const shared of [false, true]) {
    const app = createApp({ config, env, shared, chat: false })
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    t.after(async () => {
      stopChildren(app)
      await new Promise((resolve) => server.close(resolve))
    })
    const root = `http://127.0.0.1:${server.address().port}`
    const response = await fetch(`${root}/api/local-projects`)
    assert.equal(response.status, shared ? 404 : 200)
    const info = await (await fetch(`${root}/api/info`)).json()
    assert.equal(info.localProjectsEnabled, shared ? undefined : true)
    assert.equal((await fetch(`${root}/api/local-projects`, { headers: { 'X-Forwarded-For': '10.0.0.1' } })).status, 404)
    assert.equal((await fetch(`${root}/api/local-projects`, { headers: { 'Tailscale-User-Login': 'forged@example.com' } })).status, 404)
    assert.equal((await fetch(`${root}/api/local-project-id`, { headers: { 'X-Forwarded-For': '10.0.0.1' } })).status, 404)
    if (!shared) assert.ok(!(await response.text()).includes(config.file))
  }
})
