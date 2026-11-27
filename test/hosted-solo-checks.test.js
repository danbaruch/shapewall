// Checks on the solo engine (G6): src/hosted/solo/checks.js (run control and
// the SEO tab's previews), src/checks/run-control.js createInProcessChecksRuns
// and the runner's egressPinned / jobHeld options. A team server never runs
// checks. The runner itself is stubbed here (test/e2e/solo-checks.e2e.test.js
// runs a real one in a real browser); the egress proxy is real.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { readBoardJob } from '../src/board-job.js'
import { checksView, saveReport } from '../src/checks/store.js'
import { validateChecksBundle } from '../src/checks/transport.js'
import { saveSnapshot } from '../src/checks/seo-snapshot.js'
import { createInProcessChecksRuns } from '../src/checks/run-control.js'
import { runChecks } from '../src/checks/runner.js'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { projectDir } from '../src/hosted/projects.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'
import { checkReport } from './checks-fixture.js'
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

// A Playwright chromium stand-in: records the launches that reach it.
function stubChromium() {
  const launches = []
  const closed = []
  return {
    launches,
    closed,
    executablePath: () => '/bin/true',
    async launch(options) {
      launches.push(options)
      const browser = { version: () => '1.0', close: async () => closed.push(browser), on: () => {} }
      return browser
    },
  }
}

// A runChecks stand-in: records its options and the board-job lock while it
// runs, waits for release() (or the stop signal) when asked to, and saves a
// report per page view like a real run.
function stubRun({ hold = false, seoSnapshot = false } = {}) {
  const calls = []
  let release = () => {}
  const gate = hold ? new Promise((resolve) => (release = resolve)) : Promise.resolve()
  const run = async (options) => {
    const lock = readBoardJob(options.config, options.boardId)
    calls.push({ ...options, lock })
    const stopped = new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    await Promise.race([gate, stopped])
    const board = options.config.boards.find((item) => item.id === options.boardId)
    const pages = options.only ? board.pages.filter((page) => options.only.includes(page.id)) : board.pages
    const saved = []
    for (const page of pages)
      for (const viewport of page.viewports) {
        if (options.signal.aborted) break
        options.onProgress(`Checking ${page.id} ${viewport}`)
        const report = checkReport(options.config, { pageId: page.id, viewport, finding: false })
        report.profile.seo = seoSnapshot
        // As runner.js: the engine's marker, and the write fence before each write.
        report.profile.location = options.location === 'engine' ? 'engine' : 'local'
        saved.push(await saveReport(options.config, report, { fence: options.fence }))
        options.fence?.()
        if (seoSnapshot)
          saveSnapshot(options.config, {
            schemaVersion: 1,
            reportId: report.id,
            boardId: report.boardId,
            pageId: report.pageId,
            environment: report.environment,
            viewport: report.viewport.name,
            auditedAt: report.auditedAt,
            url: 'https://example.test/',
            title: `Fictional ${page.id}`,
            description: 'A fictional description that is long enough to count as a real sentence.',
            canonical: null,
            robots: '',
            language: 'en',
            social: { title: '', description: '', siteName: '', type: '', card: '', image: false },
            image: null,
          })
      }
    if (options.signal.aborted) Object.defineProperty(saved, 'stopped', { value: { checked: saved.length, total: options.limit } })
    return saved
  }
  return { run, calls, release: () => release() }
}

async function startSolo(name, { solo = {}, config = projectConfig(`${name}-project`) } = {}) {
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester', allowCapture: true, ...solo },
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
  const base = `/w/${owner.workspaceId}/p/${owner.projectId}/api`
  return { hosted, browser, owner, base, config }
}

async function finished(browser, base) {
  for (let i = 0; i < 300; i++) {
    const view = await browser.get(`${base}/boards/sample/checks/run`)
    if (view.json.run && view.json.run.state !== 'running') return view.json
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('the checks run did not finish')
}

const engineFolder = (hosted, owner) => projectDir(hosted.dataDir, owner.workspaceId, owner.projectId)

test('a team server never runs checks: no run route, no checksRun feature, previews empty', async () => {
  const hosted = await startHostedServer('solo-checks-team')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Team')
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  for (const method of ['GET', 'POST', 'DELETE']) {
    const answer = await owner.browser.call(method, `${base}/boards/sample/checks/run`, method === 'POST' ? { body: {} } : {})
    assert.ok([403, 404].includes(answer.status), `${method} ${answer.status}`)
    assert.notEqual(answer.json?.canRun, true)
  }
  const info = await owner.browser.get(`${base}/info`)
  assert.equal('soloFeatures' in info.json, false)
  assert.equal(hosted.app.locals.soloChecks, undefined)
})

test('the engine owner runs checks from the board: in process, the egress browser, the board-job lock, reports in the engine folder', async () => {
  const stub = stubRun()
  const chromium = stubChromium()
  const { hosted, browser, base, owner } = await startSolo('solo-checks-run', { solo: { checks: { run: stub.run, chromium } } })
  const info = await browser.get(`${base}/info`)
  assert.equal(info.json.soloFeatures.checksRun, true)
  const before = await browser.get(`${base}/boards/sample/checks/run`)
  assert.equal(before.status, 200, before.text)
  assert.equal(before.json.canRun, true)
  assert.equal(before.json.run, null)
  assert.equal(before.headers['cache-control'], 'no-store')

  const started = await browser.post(`${base}/boards/sample/checks/run`, { seo: false })
  assert.equal(started.status, 202, started.text)
  assert.equal(started.json.run.state, 'running')
  const done = await finished(browser, base)
  assert.equal(done.run.state, 'complete', JSON.stringify(done.run))
  assert.equal(done.run.checked, 5)
  assert.equal(done.run.message, 'Checked 5 page views.')

  const [call] = stub.calls
  assert.equal(call.egressPinned, true, 'the runner neither launches a browser nor sets a context proxy')
  assert.equal(call.jobHeld, true)
  assert.equal(call.location, 'engine', 'its reports say the engine ran them')
  assert.equal(typeof call.fence, 'function')
  assert.ok(call.browser, 'the run got the egress browser')
  assert.equal(call.lock?.kind, 'checks', 'the board-job lock is held while the run runs')
  assert.equal(call.config.outputDir, engineFolder(hosted, owner))
  assert.equal(call.seo, false)
  assert.equal(call.limit, 5)
  // The browser went through the egress proxy, with the capture browser's flags last.
  assert.equal(chromium.launches.length, 1)
  assert.match(chromium.launches[0].proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(chromium.launches[0].args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'))
  assert.ok(chromium.closed.length >= 1, 'the run closed its browser')
  assert.equal(readBoardJob({ outputDir: engineFolder(hosted, owner) }, 'sample'), null, 'and let go of the board')

  // The board's Checks panel reads the engine's reports.
  const checks = await browser.get(`${base}/boards/sample/checks`)
  assert.equal(checks.status, 200)
  assert.equal(checks.json.views.filter((view) => view.report).length, 5)
  // The engine ran them: the owner's view is a local one (sign-in and page setup checked against the live config).
  assert.equal(checks.json.imported, false)
  // A changed page setup in the file makes that page's report stale, as on a local board.
  const raw = JSON.parse(fs.readFileSync(call.config.file, 'utf8'))
  raw.pages[0].waitFor = '#changed'
  fs.writeFileSync(call.config.file, JSON.stringify(raw, null, 2))
  const later = await browser.get(`${base}/boards/sample/checks`)
  assert.ok(
    later.json.views.some((view) => view.pageId === 'home' && view.state === 'stale'),
    JSON.stringify(later.json.views.map((view) => [view.pageId, view.state])),
  )
})

test('checks.seo in the config stays in charge when SEO is on; a page subset checks those pages only', async () => {
  const stub = stubRun()
  const config = projectConfig('solo-checks-seo-list-project', { checks: { seo: ['home'] } })
  const { browser, base } = await startSolo('solo-checks-seo-list', {
    config,
    solo: { checks: { run: stub.run, chromium: stubChromium() } },
  })
  assert.equal((await browser.get(`${base}/boards/sample/checks/run`)).json.seoDefault, true)
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, { pages: ['pricing'] })).status, 202)
  const done = await finished(browser, base)
  assert.equal(done.run.checked, 2)
  assert.deepEqual(stub.calls[0].seo, ['home'])
  assert.deepEqual(stub.calls[0].only, ['pricing'])
})

test('only the owner on this machine starts or stops a run; others read canRun false', async () => {
  const stub = stubRun({ hold: true })
  const { hosted, browser, base } = await startSolo('solo-checks-owner', { solo: { checks: { run: stub.run, chromium: stubChromium() } } })
  // Another site's page (a cross-origin form or fetch): refused.
  const cross = await browser.post(`${base}/boards/sample/checks/run`, {}, { headers: { Origin: 'http://evil.example' } })
  assert.equal(cross.status, 403)
  assert.ok(['bad_origin', 'checks_owner_only'].includes(cross.json.error.code), cross.text)
  // The engine on a bare loopback name: the session cookie does not go there, and no run starts.
  const bare = createBrowser(hosted.port, `http://127.0.0.1:${hosted.port}`)
  const anon = await bare.post(`${base}/boards/sample/checks/run`, {})
  assert.notEqual(anon.status, 202)
  // Not JSON: refused before anything runs (a cross-site form cannot send JSON).
  const form = await browser.post(`${base}/boards/sample/checks/run`, 'seo=true', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(form.status, 415)
  assert.equal(stub.calls.length, 0)

  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, {})).status, 202)
  const again = await browser.post(`${base}/boards/sample/checks/run`, {})
  assert.equal(again.status, 409)
  assert.equal(again.json.error.code, 'checks_running')
  const crossStop = await browser.call('DELETE', `${base}/boards/sample/checks/run`, { headers: { Origin: 'http://evil.example' } })
  assert.equal(crossStop.status, 403)
  const stop = await browser.call('DELETE', `${base}/boards/sample/checks/run`)
  assert.equal(stop.status, 200, stop.text)
  assert.equal(stop.json.stopping, true)
  const done = await finished(browser, base)
  assert.equal(done.run.state, 'stopped', JSON.stringify(done.run))
  assert.match(done.run.message, /^Stopped after 0 of 5 page views\./)
})

test('an app origin the engine may not reach: 400 before anything runs, the board stays free', async () => {
  const stub = stubRun()
  const chromium = stubChromium()
  const config = projectConfig('solo-checks-origin-project', { baseUrl: 'http://localhost:9222/' })
  const { hosted, browser, base, owner } = await startSolo('solo-checks-origin', { config, solo: { checks: { run: stub.run, chromium } } })
  const answer = await browser.post(`${base}/boards/sample/checks/run`, {})
  assert.equal(answer.status, 400, answer.text)
  assert.equal(answer.json.error.code, 'checks_origin_refused')
  assert.match(answer.json.error.message, /does not check .*debugging port/)
  assert.equal(stub.calls.length, 0)
  assert.equal(chromium.launches.length, 0)
  assert.equal(readBoardJob({ outputDir: engineFolder(hosted, owner) }, 'sample'), null)
  const view = await browser.get(`${base}/boards/sample/checks/run`)
  assert.equal(view.json.run, null, 'no run is left behind')
  // The engine itself (its own host, on any port spelling): refused too.
  fs.writeFileSync(config.file, JSON.stringify({ ...structuredClone(SAMPLE), baseUrl: `${hosted.origin}/` }, null, 2))
  const self = await browser.post(`${base}/boards/sample/checks/run`, {})
  assert.equal(self.status, 400)
  assert.equal(self.json.error.code, 'checks_origin_refused')
})

test('the default environment only, for now', async () => {
  const config = projectConfig('solo-checks-env-project', {
    environments: [
      { id: 'local', baseUrl: 'http://127.0.0.1:9' },
      { id: 'staging', baseUrl: 'http://127.0.0.1:10' },
    ],
  })
  const stub = stubRun()
  const { browser, base } = await startSolo('solo-checks-env', { config, solo: { checks: { run: stub.run, chromium: stubChromium() } } })
  const answer = await browser.post(`${base}/boards/sample/checks/run`, { env: 'staging' })
  assert.equal(answer.status, 400)
  assert.equal(answer.json.error.code, 'unknown_environment')
  assert.equal(stub.calls.length, 0)
})

test('one job at a time on the engine: checks wait for a capture, a capture waits for checks', async () => {
  const checksRun = stubRun({ hold: true })
  let releaseCapture = () => {}
  const captureRun = async () => {
    await new Promise((resolve) => (releaseCapture = resolve))
    return { ok: true, total: 0, failed: 0 }
  }
  const real = stubChromium()
  const { browser, base } = await startSolo('solo-checks-jobs', {
    solo: { checks: { run: checksRun.run, chromium: real }, capture: { run: captureRun, chromium: real } },
  })
  assert.equal((await browser.post(`${base}/boards/sample/capture`, {})).status, 202)
  const refused = await browser.post(`${base}/boards/sample/checks/run`, {})
  assert.equal(refused.status, 409, refused.text)
  assert.match(refused.json.error.message, /capture is running/i)
  releaseCapture()
  for (let i = 0; i < 200; i++) {
    const view = await browser.get(`${base}/boards/sample`)
    if (!view.json.capture?.running) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, {})).status, 202)
  const capture = await browser.post(`${base}/boards/sample/capture`, {})
  assert.equal(capture.status, 409, capture.text)
  assert.equal(capture.json.error.code, 'engine_busy')
  assert.match(capture.json.error.message, /Checks are running/)
  checksRun.release()
  assert.equal((await finished(browser, base)).run.state, 'complete')
})

test('a push of the board waits while checks hold it', async () => {
  const stub = stubRun({ hold: true })
  const { hosted, browser, base, owner } = await startSolo('solo-checks-push', {
    solo: { checks: { run: stub.run, chromium: stubChromium() } },
  })
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, {})).status, 202)
  for (let i = 0; i < 200 && !stub.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const job = readBoardJob({ outputDir: engineFolder(hosted, owner) }, 'sample')
  assert.equal(job?.kind, 'checks')
  stub.release()
  await finished(browser, base)
})

test('the SEO tab: the owner gets the engine’s own previews; a run that stops keeps the views it finished', async () => {
  const stub = stubRun({ seoSnapshot: true })
  const { browser, base } = await startSolo('solo-checks-seo', { solo: { checks: { run: stub.run, chromium: stubChromium() } } })
  const empty = await browser.get(`${base}/boards/sample/checks/seo`)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.snapshots, {})
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, { seo: true })).status, 202)
  await finished(browser, base)
  const seo = await browser.get(`${base}/boards/sample/checks/seo`)
  assert.equal(seo.status, 200, seo.text)
  assert.equal(seo.headers['cache-control'], 'no-store')
  const titles = Object.values(seo.json.snapshots).map((snapshot) => snapshot.title)
  assert.ok(titles.includes('Fictional home'), JSON.stringify(seo.json))
  assert.deepEqual(seo.json.privatePages, [])
})

test('--read-only and --no-capture keep Run off; the panel says why', async () => {
  for (const solo of [{ readOnly: true }, { allowCapture: false }]) {
    const stub = stubRun()
    const { browser, base } = await startSolo(`solo-checks-off-${Object.keys(solo)[0]}`, { solo: { ...solo, checks: { run: stub.run } } })
    const view = await browser.get(`${base}/boards/sample/checks/run`)
    assert.equal(view.status, 200)
    assert.equal(view.json.canRun, false)
    assert.match(view.json.reason, /can’t be started/)
    const answer = await browser.post(`${base}/boards/sample/checks/run`, {})
    assert.equal(answer.status, 403)
    assert.equal(stub.calls.length, 0)
  }
})

test('removing the board stops its run first, and closing the engine stops a run and waits for it', async () => {
  const stub = stubRun({ hold: true })
  const { hosted, browser, base, owner } = await startSolo('solo-checks-remove', {
    solo: { checks: { run: stub.run, chromium: stubChromium() } },
  })
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, {})).status, 202)
  for (let i = 0; i < 200 && !stub.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(await hosted.app.locals.soloChecks.cancel(owner.projectId, 'other'), false, 'another board: nothing to stop')
  const gone = await browser.call('DELETE', `/api/workspaces/${owner.workspaceId}/projects/${owner.projectId}/boards/sample`)
  assert.equal(gone.status, 200, gone.text)
  assert.equal(fs.existsSync(path.join(engineFolder(hosted, owner), 'sample')), false, 'nothing wrote the folder after it went')

  const second = stubRun({ hold: true })
  const other = await startSolo('solo-checks-close', { solo: { checks: { run: second.run, chromium: stubChromium() } } })
  assert.equal((await other.browser.post(`${other.base}/boards/sample/checks/run`, {})).status, 202)
  for (let i = 0; i < 200 && !second.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  await other.hosted.close()
  servers.splice(servers.indexOf(other.hosted), 1)
  assert.equal(readBoardJob({ outputDir: engineFolder(other.hosted, other.owner) }, 'sample'), null)
})

test('createInProcessChecksRuns: a refused prepare leaves no run; a runner error reads as failed without paths', async () => {
  const board = sampleConfig('solo-checks-unit').boards[0]
  let refuse = true
  const closes = []
  const runs = createInProcessChecksRuns({
    prepare: async () => {
      if (refuse) throw Object.assign(new Error('no'), { statusCode: 409, code: 'engine_busy' })
      return { config: { checks: {} }, options: {}, close: async () => closes.push(1) }
    },
    runChecks: async () => {
      throw new Error('shapewall: could not read /home/someone/project/secret/file.json')
    },
  })
  await assert.rejects(runs.start(board), (error) => error.code === 'engine_busy')
  assert.equal(runs.state('sample'), null)
  assert.equal(runs.running(), false)
  refuse = false
  const run = await runs.start(board)
  await run.finished
  const state = runs.state('sample')
  assert.equal(state.state, 'failed')
  assert.doesNotMatch(state.message, /home|someone/)
  assert.deepEqual(closes, [1])
})

test('runChecks with egressPinned never launches a browser of its own', async () => {
  const config = sampleConfig('solo-checks-pinned')
  await assert.rejects(
    runChecks({ config, boardId: 'sample', egressPinned: true, jobHeld: true, limit: 5 }),
    /Page check browser unavailable/,
  )
})

test('rev63 C1: a runner that ignores the stop is fenced before its browser closes, and the run ends as stopped', async () => {
  const board = sampleConfig('solo-checks-stuck').boards[0]
  const events = []
  let call = null
  let wake = () => {}
  const runs = createInProcessChecksRuns({
    graceMs: 30,
    prepare: async () => ({
      config: { checks: {} },
      options: {},
      close: async () => {
        try {
          call.fence()
          events.push('closed before the fence')
        } catch {
          events.push('closed after the fence')
        }
      },
    }),
    // Ignores the signal and the closed browser (a login script awaiting something else).
    runChecks: (options) => {
      call = options
      return new Promise((resolve) => (wake = resolve))
    },
  })
  await runs.start(board, {})
  assert.equal(runs.running(), true)
  assert.doesNotThrow(() => call.fence(), 'a running run may write')
  // What removing the board and closing the engine wait for: it returns.
  assert.equal(await runs.stopAndWait('sample'), true)
  assert.equal(runs.running(), false)
  const state = runs.state('sample')
  assert.equal(state.state, 'stopped')
  assert.match(state.message, /did not stop in time, so its browser was closed/)
  assert.deepEqual(events, ['closed after the fence'])
  assert.throws(() => call.fence(), /stopped/, 'nothing the runner does later is written')
  // The runner wakes up and answers: ignored.
  wake([{ state: 'complete' }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runs.state('sample').state, 'stopped')
  assert.deepEqual(events, ['closed after the fence'])
  // The slot is free again.
  const next = createInProcessChecksRuns({
    prepare: async () => ({ config: { checks: {} }, options: {}, close: async () => {} }),
    runChecks: async () => [],
  })
  await (
    await next.start(board, {})
  ).finished
  assert.equal(next.state('sample').state, 'complete')
})

test('rev63 C1 on the engine: a stuck run does not hold up removing the board or stopping the engine, and writes nothing after', async () => {
  const calls = []
  const late = []
  let wake = () => {}
  const woken = new Promise((resolve) => (wake = resolve))
  // Never gives up on the stop; when it wakes, it tries to save a report as runner.js would.
  const run = async (options) => {
    calls.push(options)
    await woken
    const report = checkReport(options.config, { pageId: 'home', viewport: 'desktop', finding: false })
    report.profile.location = 'engine'
    late.push(saveReport(options.config, report, { fence: options.fence }))
    await late.at(-1)
    return [report]
  }
  const { hosted, browser, base, owner } = await startSolo('solo-checks-stuck', {
    solo: { checks: { run, chromium: stubChromium(), graceMs: 30 } },
  })
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, {})).status, 202)
  for (let i = 0; i < 200 && !calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const gone = await browser.call('DELETE', `/api/workspaces/${owner.workspaceId}/projects/${owner.projectId}/boards/sample`)
  assert.equal(gone.status, 200, gone.text)
  const folder = path.join(engineFolder(hosted, owner), 'sample')
  assert.equal(fs.existsSync(folder), false)
  assert.equal(readBoardJob({ outputDir: engineFolder(hosted, owner) }, 'sample'), null)
  wake()
  await assert.rejects(
    (async () => {
      for (let i = 0; i < 200 && !late.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
      await late[0]
    })(),
    /stopped/,
  )
  assert.equal(fs.existsSync(folder), false, 'the late runner did not bring the folder back')

  const stuck = () => new Promise(() => {})
  const other = await startSolo('solo-checks-stuck-close', {
    solo: { checks: { run: (options) => (calls.push(options), stuck()), chromium: stubChromium(), graceMs: 30 } },
  })
  const before = calls.length
  assert.equal((await other.browser.post(`${other.base}/boards/sample/checks/run`, {})).status, 202)
  for (let i = 0; i < 200 && calls.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  servers.splice(servers.indexOf(other.hosted), 1)
  await other.hosted.close()
  assert.equal(readBoardJob({ outputDir: engineFolder(other.hosted, other.owner) }, 'sample'), null)
})

test('rev63 C2: the owner sees reports a push brought as imported, the engine’s own runs as its own', async () => {
  const stub = stubRun()
  const { browser, base } = await startSolo('solo-checks-source', { solo: { checks: { run: stub.run, chromium: stubChromium() } } })
  assert.equal((await browser.post(`${base}/boards/sample/checks/run`, { seo: false })).status, 202)
  await finished(browser, base)
  const own = await browser.get(`${base}/boards/sample/checks`)
  assert.equal(own.json.imported, false)
  assert.ok(own.json.views.every((view) => view.imported === false))

  // A push from another machine brings a newer report of home: its sign-in
  // and page setup are that machine's, so it must not read as stale here.
  const config = stub.calls[0].config
  const pushed = checkReport(config, { pageId: 'home', viewport: 'desktop', finding: false })
  pushed.profile.stateFingerprint = 'a'.repeat(64)
  await saveReport(config, pushed)
  const mixed = await browser.get(`${base}/boards/sample/checks`)
  assert.equal(mixed.json.imported, true, 'the panel says some reports were imported')
  const home = mixed.json.views.find((view) => view.pageId === 'home' && view.viewport === 'desktop')
  assert.equal(home.report.id, pushed.id)
  assert.equal(home.imported, true)
  assert.equal(home.state, 'complete', 'not stale for this machine’s setup')
  assert.ok(mixed.json.views.filter((view) => view !== home).every((view) => view.imported === false))

  // Elsewhere nothing changes: a local board judges every report itself, a hosted one imports all.
  assert.equal(checksView(config, 'sample').imported, false)
  assert.equal(checksView(config, 'sample').views[0].imported, undefined)
  assert.equal(checksView(config, 'sample', null, { imported: true }).imported, true)
  // A carried bundle never brings a report that claims to be an engine run.
  const board = config.boards[0]
  const claimed = checkReport(config, { pageId: 'home', viewport: 'desktop', finding: false })
  claimed.profile.location = 'engine'
  assert.throws(() => validateChecksBundle({ schemaVersion: 1, reports: [claimed] }, board, config.viewports), /local run/)
  assert.equal(validateChecksBundle({ schemaVersion: 1, reports: [pushed] }, board, config.viewports).reports.length, 1)
})
