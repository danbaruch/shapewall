import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { tempDir } from '../helpers.js'
import { runLighthouseAudits } from '../../src/checks/lighthouse.js'
import { fingerprint } from '../../src/checks/schema.js'

let server,
  origin,
  directory,
  actions = 0
const html = (body, script = '') =>
  `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local audit fixture</title><meta name="description" content="A deliberately simple local fixture for repeatable browser navigation audits."><style>body{font:20px system-ui;margin:24px}main{max-width:700px}button{padding:14px}</style></head><body><main>${body}</main><script>${script}</script></body></html>`
before(async () => {
  directory = tempDir('lighthouse-browser')
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture')
    if (url.pathname === '/action') {
      actions += 1
      res.end('ok')
      return
    }
    if (url.pathname === '/app' && !req.headers.cookie?.includes('session=fixture-secret-auth')) {
      res.writeHead(302, { Location: '/login' })
      res.end()
      return
    }
    res.setHeader('Content-Type', 'text/html')
    if (url.pathname === '/app') {
      res.end(
        html(
          '<h1 id="member-ready">Member dashboard</h1><p>This is the intended signed-in application.</p><button id="expand">Expand details</button>',
          `if(localStorage.getItem('role')!=='member')location.replace('/login');document.querySelector('#expand').onclick=()=>{document.body.dataset.expanded='yes';fetch('/action',{method:'POST'})}`,
        ),
      )
      return
    }
    if (url.pathname === '/login') {
      res.end(html('<h1>Sign in</h1>'))
      return
    }
    res.end(
      html(
        '<h1 id="ready">Public product page</h1><p>A visible paragraph supplies genuine navigation paint metrics.</p><button>Inspect product</button>',
      ),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function config(name, { auth = null, app = false, ready = true } = {}) {
  const dir = path.join(directory, name)
  fs.mkdirSync(dir, { recursive: true })
  return normalizeConfig(
    {
      title: 'Audit fixture',
      baseUrl: origin,
      outputDir: path.join(dir, '.shapewall'),
      viewports: { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } },
      pages: [
        {
          id: 'home',
          path: app ? '/app?token=fixture-query-secret' : '/',
          ...(ready ? { waitFor: app ? '#member-ready' : '#ready' } : {}),
          ...(app ? { actions: [{ click: '#expand' }] } : {}),
        },
      ],
      ...(auth ? { auth } : {}),
      timeouts: { page: 10000, settle: 1000 },
    },
    { dir, file: path.join(dir, 'shapewall.config.json') },
  )
}

function assertClean(config, reports) {
  const work = path.join(config.outputDir, '.checks-browser')
  if (fs.existsSync(work)) assert.deepEqual(fs.readdirSync(work), [], 'owned Chrome profiles and credentials are removed')
  assert.doesNotMatch(JSON.stringify(reports), /fixture-secret-auth|fixture-query-secret|127\.0\.0\.1|\/login|\/app\?|member-ready/)
}

test('real Lighthouse desktop and phone navigate original public app and record tool conditions', { timeout: 180000 }, async () => {
  const conf = config('public')
  const { reports, summary } = await runLighthouseAudits({
    chromePath: chromium.executablePath(),
    config: conf,
    seo: true,
    production: 'production',
    sourceBuild: 'a'.repeat(64),
  })
  assert.equal(reports.length, 2)
  assert.equal(reports[0].profile.sourceBuild, fingerprint('a'.repeat(64)))
  assert.equal(summary.failed, 0)
  for (const report of reports) {
    assert.equal(report.state, 'complete')
    assert.equal(report.profile.version, '13.6.0')
    assert.match(report.profile.browser.version, /^\d+\./)
    assert.equal(report.profile.cache, 'cold')
    assert.equal(report.profile.device.mobile, report.viewport.name === 'phone')
    for (const key of ['largestContentfulPaintMs', 'cumulativeLayoutShift', 'firstContentfulPaintMs', 'totalBlockingTimeMs'])
      assert.ok(Number.isFinite(report.metrics[key]), key)
    assert.equal(report.sampledSeparately, true)
    assert.equal(report.captureVersion, null)
  }
  assert.notDeepEqual(reports[0].profile.device, reports[1].profile.device)
  assertClean(conf, reports)
})

test(
  'configured Playwright cookie and localStorage reach the authenticated original route; actions run once',
  { timeout: 120000 },
  async () => {
    const stateFile = path.join(directory, 'private-state.json')
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        cookies: [
          {
            name: 'session',
            value: 'fixture-secret-auth',
            domain: '127.0.0.1',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [{ origin, localStorage: [{ name: 'role', value: 'member' }] }],
      }),
      { mode: 0o600 },
    )
    const conf = config('authenticated', { app: true, auth: { storageState: stateFile } })
    const before = actions
    const { reports } = await runLighthouseAudits({ chromePath: chromium.executablePath(), config: conf, viewports: 'desktop' })
    assert.equal(reports[0].state, 'complete', JSON.stringify(reports[0].findings))
    assert.equal(reports[0].profile.authRole, 'configured')
    assert.equal(reports[0].profile.cache, 'auth-preserved')
    assert.match(reports[0].profile.authStateHash, /^[a-f0-9]{64}$/)
    assert.equal(actions - before, 1, 'preparation does not replay app actions')
    assertClean(conf, reports)
  },
)

test('a sign-in redirect is a failed audit with unknown metrics, never a passing app measurement', { timeout: 60000 }, async () => {
  const stateFile = path.join(directory, 'signed-out-state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 })
  const conf = config('redirect', { app: true, auth: { storageState: stateFile } })
  const { reports } = await runLighthouseAudits({ chromePath: chromium.executablePath(), config: conf, viewports: 'desktop' })
  assert.equal(reports[0].state, 'failed')
  assert.equal(reports[0].findings[0].id, 'wrong-target')
  assert.ok(Object.values(reports[0].metrics).every((value) => value === null))
  assertClean(conf, reports)
})

test('trusted login fixture uses the selected environment and reaches the prepared Lighthouse browser', { timeout: 120000 }, async () => {
  const loginScript = path.join(directory, 'login-fixture.mjs')
  fs.writeFileSync(
    loginScript,
    `export default async function({page,context,baseUrl}) {
    await page.goto(baseUrl);
    await context.addCookies([{name:'session',value:'fixture-secret-auth',domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Lax'}]);
    await page.evaluate(()=>localStorage.setItem('role','member'));
  }`,
    { mode: 0o600 },
  )
  const conf = config('login-fixture', { app: true, auth: { loginScript } })
  conf.boards[0].baseUrl = 'http://127.0.0.1:1'
  conf.boards[0].environments.push({ id: 'preview', title: 'Preview', baseUrl: origin })
  const { reports } = await runLighthouseAudits({
    chromePath: chromium.executablePath(),
    config: conf,
    envId: 'preview',
    viewports: 'phone',
  })
  assert.equal(reports[0].environment, 'preview')
  assert.equal(reports[0].state, 'complete', JSON.stringify(reports[0].findings))
  assert.equal(reports[0].profile.authRole, 'configured')
  assert.equal(reports[0].profile.cache, 'auth-preserved')
  assertClean(conf, reports)
})

test('warm repeated navigations keep separate raw samples and clean up each browser', { timeout: 180000 }, async () => {
  const conf = config('warm')
  const { reports } = await runLighthouseAudits({
    chromePath: chromium.executablePath(),
    config: conf,
    viewports: 'desktop',
    cache: 'warm',
    samples: 2,
  })
  assert.equal(reports.length, 2)
  assert.equal(reports[0].runId, reports[1].runId)
  assert.notEqual(reports[0].id, reports[1].id)
  assert.ok(reports.every((report) => report.state === 'complete' && report.profile.cache === 'warm' && report.profile.sampleCount === 1))
  assertClean(conf, reports)
})

test(
  'anonymous login redirects during the measured pass do not expose login metrics or unhandled failures',
  { timeout: 120000 },
  async () => {
    const conf = config('anonymous-redirect', { app: true })
    const { reports } = await runLighthouseAudits({ chromePath: chromium.executablePath(), config: conf, viewports: 'desktop' })
    assert.equal(reports[0].state, 'failed')
    assert.equal(reports[0].findings[0].id, 'wrong-target')
    assert.ok(Object.values(reports[0].metrics).every((value) => value === null))
    assertClean(conf, reports)
  },
)
