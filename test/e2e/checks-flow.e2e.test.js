import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { normalizeConfig } from '../../src/config.js'
import { main } from '../../src/cli.js'
import { runFlowAudit, runAccessibilityAudit, flowCommand, accessibilityCommand } from '../../src/checks/flows.js'
import { tempDir } from '../helpers.js'

let browser
before(async () => {
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
})
async function fixture(t) {
  let logins = 0
  let mutations = 0,
    fixed = false,
    huge = false,
    shadow = false
  const server = http.createServer((req, res) => {
    if (req.url === '/prepare') {
      logins++
      res.setHeader('set-cookie', 'session=fixture; Path=/; HttpOnly')
      res.end('Ready')
      return
    }
    if (req.url === '/mutate') {
      mutations++
      res.end('{}')
      return
    }
    if (!req.headers.cookie?.includes('session=fixture')) {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    res.setHeader('content-type', 'text/html')
    const bad = fixed ? '<button id="bad">Named control</button>' : '<button id="bad"></button>'
    res.end(`<!doctype html><html lang="en"><head><title>Private account title</title><meta name="viewport" content="width=device-width"><style>body{background:white;color:black}button{color:black;background:white;min-width:44px;min-height:44px;margin:8px}</style></head><body><main id="ready"><h1>Example</h1><button id="advance">Advance</button><div id="result">${bad}</div>${huge ? '<p>large</p>'.repeat(10001) : ''}<script>
      document.querySelector('#advance').addEventListener('click',async()=>{await fetch('/mutate',{method:'POST'});document.querySelector('#result').innerHTML=${JSON.stringify(bad)};document.querySelector('#result').id='done'});
      ${shadow ? `const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<p>large</p>'.repeat(10001);` : ''}
    </script></main></body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const dir = tempDir('flow-browser'),
    state = path.join(dir, 'state.json')
  fs.writeFileSync(
    state,
    JSON.stringify({
      cookies: [
        { name: 'session', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
      ],
      origins: [],
    }),
  )
  const config = normalizeConfig(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      pages: [{ id: 'home', path: '/', waitFor: '#ready', actions: [{ click: '#advance' }] }],
      viewports: { desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 900 }, phone: { width: 390, height: 844 } },
      auth: { storageState: state },
      timeouts: { page: 1000, settle: 50 },
    },
    { dir },
  )
  return {
    config,
    mutations: () => mutations,
    logins: () => logins,
    set: (options) => {
      if ('fixed' in options) fixed = options.fixed
      if ('huge' in options) huge = options.huge
      if ('shadow' in options) shadow = options.shadow
    },
  }
}
const flow = (steps, accessibility = false) => ({ schemaVersion: 1, pageId: 'home', viewport: 'desktop', steps, accessibility })

test('signed-in flow executes mutating step once, ignores capture actions, and measures final axe state', async (t) => {
  const f = await fixture(t),
    beforeContexts = browser.contexts().length
  const reports = await runFlowAudit({
    browser,
    config: f.config,
    flow: flow([{ action: { click: '#advance' }, ready: '#done', maxDurationMs: 1 }], true),
  })
  assert.equal(f.mutations(), 1)
  assert.equal(reports.length, 2)
  const [interaction, accessibility] = reports
  assert.equal(interaction.state, 'complete')
  assert.equal(interaction.profile.runner, 'playwright-flow')
  assert.equal(interaction.profile.mode, 'timespan')
  assert.equal(interaction.metrics.completedSteps, 1)
  assert.ok(interaction.metrics.step1DurationMs > 0)
  assert.ok(interaction.findings.some((f) => f.id === 'flow-step-1-budget'))
  assert.equal(accessibility.profile.runner, 'axe')
  assert.ok(accessibility.findings.some((f) => f.id === 'axe-button-name'))
  assert.equal(interaction.profile.flowHash, accessibility.profile.flowHash)
  assert.equal(interaction.profile.authRole, 'configured')
  assert.doesNotMatch(JSON.stringify(reports), /Private account|session|127\.0\.0\.1|#advance|#ready|\/mutate/)
  assert.equal(browser.contexts().length, beforeContexts)
})

test('actual violation is absent after fixing control name; desktop tablet and phone snapshots preserve dimensions', async (t) => {
  const f = await fixture(t)
  f.config.boards[0].pages[0].actions = []
  const before = await runAccessibilityAudit({ browser, config: f.config, pageId: 'home', viewport: 'desktop' })
  assert.ok(before[0].findings.some((f) => f.id === 'axe-button-name'))
  f.set({ fixed: true })
  for (const viewport of ['desktop', 'tablet', 'phone']) {
    const [report] = await runAccessibilityAudit({ browser, config: f.config, pageId: 'home', viewport })
    assert.equal(report.state, 'complete')
    assert.equal(report.metrics.violationRules, 0)
    assert.ok(!report.findings.some((f) => f.id === 'axe-button-name'))
    assert.equal(report.viewport.width, f.config.viewports[viewport].width)
  }
  assert.equal(f.mutations(), 0)
})

test('standalone snapshot runs configured page actions once and never retries a timeout mutation', async (t) => {
  const f = await fixture(t)
  await runAccessibilityAudit({ browser, config: f.config, pageId: 'home' })
  assert.equal(f.mutations(), 1)
  const [failed] = await runFlowAudit({
    browser,
    config: f.config,
    flow: flow([{ action: { click: '#advance' }, ready: '#done' }, { action: { waitFor: '#never' } }], true),
  })
  assert.equal(f.mutations(), 2)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.metrics.completedSteps, 1)
  assert.equal(failed.metrics.step2DurationMs, null)
  assert.equal(failed.metrics.flowDurationMs, null)
  assert.ok(failed.findings.some((f) => f.id === 'flow-failed'))
})

test('cancellation closes owned contexts, retains failed report and never repeats completed steps', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    before = browser.contexts().length
  const run = runFlowAudit({
    browser,
    config: f.config,
    signal: controller.signal,
    flow: flow([{ action: { click: '#advance' }, ready: '#done' }, { action: { wait: 5000 } }]),
  })
  const timer = setTimeout(() => controller.abort(), 350)
  try {
    const [report] = await run
    assert.equal(report.state, 'failed')
    assert.ok(report.findings.some((f) => f.id === 'audit-stopped'))
    assert.equal(f.mutations(), 1)
    assert.equal(browser.contexts().length, before)
  } finally {
    clearTimeout(timer)
  }
})

test('oversized document and open shadow trees produce unsupported accessibility snapshots', async (t) => {
  const f = await fixture(t)
  f.config.boards[0].pages[0].actions = []
  for (const settings of [{ huge: true }, { huge: false, shadow: true }]) {
    f.set(settings)
    const [report] = await runAccessibilityAudit({ browser, config: f.config, pageId: 'home' })
    assert.equal(report.state, 'unsupported')
    assert.ok(report.findings.some((f) => f.id === 'axe-size-limit'))
    assert.equal(report.metrics.violationRules, undefined)
  }
})

test('invalid selection and redirected sign-in do not run mutating steps', async (t) => {
  const f = await fixture(t)
  await assert.rejects(runFlowAudit({ browser, config: f.config, flow: { ...flow([{ action: { wait: 0 } }]), pageId: 'missing' } }))
  fs.writeFileSync(f.config.auth.storageState, JSON.stringify({ cookies: [], origins: [] }))
  const [report] = await runFlowAudit({ browser, config: f.config, flow: flow([{ action: { click: '#advance' } }]) })
  assert.equal(report.state, 'failed')
  assert.equal(f.mutations(), 0)
})

test('trusted login setup runs once and command entrypoints preserve signals and bounded output', async (t) => {
  const f = await fixture(t)
  const script = path.join(f.config.dir, 'login.mjs')
  fs.writeFileSync(script, "export default async ({page,baseUrl}) => { await page.goto(baseUrl + '/prepare') }")
  f.config.auth.loginScript = script
  f.config.auth.storageState = null
  f.config.browser.executablePath = chromium.executablePath()
  const file = path.join(f.config.dir, 'flow.json')
  fs.writeFileSync(file, JSON.stringify(flow([{ action: { click: '#advance' }, ready: '#done' }], true)))
  const output = [],
    before = process.listenerCount('SIGINT')
  assert.equal(await flowCommand(f.config, [], { 'flow-file': 'flow.json', json: true }, (value) => output.push(value)), 0)
  assert.equal(f.logins(), 1)
  assert.equal(f.mutations(), 1)
  const payload = JSON.parse(output[0])
  assert.equal(payload.reports.length, 2)
  assert.equal(payload.reports[0].profile.authRole, 'configured')
  assert.doesNotMatch(output[0], /127\.0\.0\.1|session|login\.mjs|#advance/)
  assert.equal(process.listenerCount('SIGINT'), before)
  assert.equal(await accessibilityCommand(f.config, [], { only: ['home'], viewport: 'phone', json: true }, () => {}), 0)
  assert.equal(f.logins(), 2)
  assert.equal(f.mutations(), 2)
  assert.equal(process.listenerCount('SIGINT'), before)
  const cliConfig = path.join(f.config.dir, 'cli.config.json')
  fs.writeFileSync(
    cliConfig,
    JSON.stringify({
      baseUrl: f.config.boards[0].baseUrl,
      pages: [{ id: 'home', path: '/', waitFor: '#ready', actions: [{ click: '#advance' }] }],
      auth: f.config.auth,
      viewports: f.config.viewports,
      browser: f.config.browser,
      timeouts: f.config.timeouts,
    }),
  )
  const cliOutput = []
  assert.equal(
    await main(['checks', 'flow', '--config', cliConfig, '--flow-file', file, '--json'], { out: (value) => cliOutput.push(value) }),
    0,
  )
  assert.equal(f.mutations(), 3, 'central CLI dispatch performs one explicit flow only')
  assert.equal(JSON.parse(cliOutput[0]).reports.length, 2)
  await assert.rejects(
    main(['checks', 'flow', '--config', cliConfig, '--flow-file', file, '--only', 'home'], { out: () => {} }),
    /flow file selects/,
  )
  assert.equal(f.mutations(), 3, 'conflicting central CLI flags fail before execution')
})

test('audit origin guard blocks direct, redirect-hop and popup escapes before foreign requests or mutations', async (t) => {
  let sameOriginMutations = 0
  let foreignRequests = 0,
    foreignMutations = 0,
    mode = 'direct'
  const foreign = http.createServer((req, res) => {
    foreignRequests++
    if (req.url === '/mutate') foreignMutations++
    res.setHeader('content-type', 'text/html')
    res.end('<html><button id="mutate" onclick="fetch(\'/mutate\',{method:\'POST\'})">Mutate</button></html>')
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${foreign.address().port}/`
  const original = http.createServer((req, res) => {
    if (req.url === '/inside-hop') {
      res.writeHead(302, { location: '/inside' })
      res.end()
      return
    }
    if (req.url === '/inside-mutate') {
      sameOriginMutations++
      res.end('{}')
      return
    }
    if (req.url === '/inside') {
      res.setHeader('content-type', 'text/html')
      res.end(
        `<html lang="en"><title>Inside</title><main><h1>Inside</h1><button id="mutate" onclick="fetch('/inside-mutate',{method:'POST'}).then(()=>this.id='done')">Mutate</button></main></html>`,
      )
      return
    }
    if (req.url === '/hop') {
      res.writeHead(302, { location: url })
      res.end()
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(
      `<html lang="en"><title>Original</title><main><h1>Original</h1><a id="leave" ${mode === 'popup' ? 'target="_blank"' : ''} href="${mode === 'redirect' ? '/hop' : mode === 'inside' ? '/inside-hop' : url}">Continue</a></main></html>`,
    )
  })
  await new Promise((resolve) => original.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    original.closeAllConnections()
    foreign.closeAllConnections()
    original.close()
    foreign.close()
  })
  const config = normalizeConfig(
    {
      baseUrl: `http://127.0.0.1:${original.address().port}`,
      pages: [{ id: 'home', path: '/', actions: [{ click: '#leave' }, { click: '#mutate' }] }],
      viewports: { desktop: { width: 1440, height: 900 } },
      timeouts: { page: 1500, settle: 50 },
    },
    { dir: tempDir('flow-origin') },
  )
  for (mode of ['direct', 'redirect', 'popup']) {
    const [report] = await runAccessibilityAudit({ browser, config, pageId: 'home' })
    assert.equal(report.state, 'failed', mode)
    assert.ok(
      report.findings.some((f) => f.id === 'flow-origin-blocked'),
      mode,
    )
    assert.equal(foreignRequests, 0, mode)
    assert.equal(foreignMutations, 0, mode)
  }
  mode = 'redirect'
  const [flowReport] = await runFlowAudit({
    browser,
    config,
    flow: flow([{ action: { click: '#leave' } }, { action: { click: '#mutate' } }]),
  })
  assert.equal(flowReport.state, 'failed')
  assert.equal(foreignRequests, 0)
  assert.equal(foreignMutations, 0)
  mode = 'inside'
  config.boards[0].pages[0].actions.push({ type: 'waitFor', selector: '#done' })
  const [inside] = await runAccessibilityAudit({ browser, config, pageId: 'home' })
  assert.equal(inside.state, 'complete')
  assert.equal(sameOriginMutations, 1)
  assert.equal(foreignRequests, 0)
})

test('isolated axe engine still finds actual DOM violations when page globals try to fake a clean result', async (t) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(`<html lang="en"><title>Example</title><main><h1>Example</h1><button></button></main><script>
      Object.defineProperty(window,'axe',{configurable:false,get(){return {run:async()=>({violations:[],incomplete:[],passes:[]})}},set(value){}});
      Document.prototype.querySelectorAll = () => [];
    </script></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const config = normalizeConfig(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      pages: [{ id: 'home', path: '/' }],
      viewports: { desktop: { width: 1440, height: 900 } },
      timeouts: { page: 1500, settle: 50 },
    },
    { dir: tempDir('flow-isolated-axe') },
  )
  const [report] = await runAccessibilityAudit({ browser, config, pageId: 'home' })
  assert.equal(report.state, 'complete')
  assert.ok(report.findings.some((f) => f.id === 'axe-button-name'))
  assert.ok(report.metrics.scannedElements >= 8)
  assert.ok(report.metrics.violationRules > 0)
  assert.equal(report.profile.throttling.method, 'provided')
  assert.equal(report.profile.throttling.cpuSlowdownMultiplier, null)
})
