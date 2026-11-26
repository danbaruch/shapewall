// Q7 security review, batch B: the agent browser (C1, C3, C5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAgentBrowser, readAuthState } from '../src/agent/agent-browser.js'
import { ownAddresses, pinHost } from '../src/agent/browser-egress.js'
import { tempDir } from './helpers.js'

const on = (extra = {}) => ({ on: true, allow: ['http://127.0.0.1:5173'], auth: null, profile: null, realChrome: false, ...extra })
const noLaunch = (seen = []) => ({
  async launchPersistentContext(dir, options) {
    seen.push(options)
    throw new Error('stop here')
  },
})
const noBox = () => ({ use: false, why: 'test' })

test('Q7 C1: a public name resolving to an address of this machine is refused unless the machine lists it', async () => {
  const own = ownAddresses({ eth0: [{ address: '192.0.2.50' }, { address: '2001:db8::5' }] })
  const lookup = async (host) => {
    if (host === 'here.example.com') return [{ address: '192.0.2.50' }]
    if (host === 'here6.example.com') return [{ address: '2001:db8::5' }]
    return [{ address: '198.51.100.9' }]
  }
  assert.match((await pinHost('here.example.com', { lookup, own })).refused, /address of this machine/)
  assert.match((await pinHost('here6.example.com', { lookup, own })).refused, /address of this machine/)
  assert.equal((await pinHost('here.example.com', { lookup, own, allowOwn: true })).address, '192.0.2.50')
  assert.equal((await pinHost('away.example.com', { lookup, own })).address, '198.51.100.9')
})

test('Q7 C1: on a team or open turn only origins the machine lists open a port on this machine', async () => {
  const tmp = tempDir('q7-browser-machine')
  try {
    const listed = 'http://127.0.0.1:5173'
    const unlisted = 'http://127.0.0.1:8080'
    const interfaces = { eth0: [{ address: '192.0.2.50' }] }
    const agent = createAgentBrowser({
      browser: on({ allow: [listed, unlisted, 'http://192.0.2.50:3000'], machineOrigins: [listed] }),
      tmpRoot: tmp,
      chromium: noLaunch(),
      sandboxPlan: noBox,
      interfaces,
    })
    await assert.rejects(agent.page(), /stop here/)
    assert.deepEqual(
      agent.refused().map((entry) => entry.origin),
      [unlisted, 'http://192.0.2.50:3000'],
    )
    assert.match(agent.refused()[0].why, /on this machine/)
    // The owner's own turn (no machineOrigins): every loopback origin it allowed.
    const owner = createAgentBrowser({ browser: on({ allow: [listed, unlisted] }), tmpRoot: tmp, chromium: noLaunch(), sandboxPlan: noBox })
    await assert.rejects(owner.page(), /stop here/)
    assert.deepEqual(owner.refused(), [])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Q7 C3: a turn that requires Chromium's sandbox starts on this machine with it, never in the OS sandbox without it", async () => {
  const tmp = tempDir('q7-browser-required')
  try {
    const seen = []
    const chromium = {
      executablePath() {
        throw new Error('the OS sandbox start was tried')
      },
      ...noLaunch(seen),
    }
    const agent = createAgentBrowser({
      browser: on({ chromiumSandbox: 'required' }),
      tmpRoot: tmp,
      chromium,
      chromiumSandbox: false,
      sandboxPlan: () => ({ use: true, why: null }),
    })
    await assert.rejects(agent.page(), /stop here/)
    assert.equal(seen.length, 1, 'one host launch')
    assert.equal(seen[0].chromiumSandbox, true, "Chromium's own sandbox on")
    assert.match(agent.notes().join('\n'), /Chromium's own sandbox/)
    // osSandbox forced on and required: the browser stays off.
    const forced = createAgentBrowser({
      browser: on({ chromiumSandbox: 'required' }),
      tmpRoot: tmp,
      chromium,
      osSandbox: true,
      sandboxPlan: () => ({ use: true, why: null }),
    })
    await assert.rejects(forced.page(), /stays off/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Q7 C5: a recorded login's cookies for a host a session dev server listens on are left out", () => {
  const checkout = tempDir('q7-browser-auth')
  try {
    fs.mkdirSync(path.join(checkout, '.shapewall-auth'))
    fs.writeFileSync(
      path.join(checkout, '.shapewall-auth', 'main.auth.json'),
      JSON.stringify({
        cookies: [
          { name: 'app', value: '1', domain: 'app.example.com', path: '/' },
          { name: 'local', value: '2', domain: '127.0.0.1', path: '/' },
        ],
        origins: [],
      }),
    )
    const origins = ['https://app.example.com', 'http://127.0.0.1:3000']
    assert.deepEqual(
      readAuthState(checkout, 'main', origins).cookies.map((cookie) => cookie.name),
      ['app', 'local'],
    )
    assert.deepEqual(
      readAuthState(checkout, 'main', origins, { portless: ['127.0.0.1'] }).cookies.map((cookie) => cookie.name),
      ['app'],
    )
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true })
  }
})
