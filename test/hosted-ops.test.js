import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { openDatabase, migrate } from '../src/hosted/db.js'
import { createHostedApp } from '../src/hosted/app.js'
import { backup, restore, restoreDrill } from '../src/hosted/backup.js'
import { planWorkspaceExport, writeWorkspaceExport } from '../src/hosted/admin.js'
import { tenant } from '../src/hosted/tenancy.js'
import { readZip } from '../src/hosted/zip.js'
import { listWorkspaces, operatorLog, suspendWorkspace, resumeWorkspace, createReport, closeReport } from '../src/hosted/operator.js'
import { createQuotas, parseQuotas } from '../src/hosted/quotas.js'
import { planBoardRetention, runRetention } from '../src/hosted/retention.js'
import { shareOnly, shareOnlyAllowed, startTailscale } from '../src/hosted/tailscale.js'
import { renderCompose, renderCaddyfile, setupHosted, startCompose } from '../src/hosted/setup.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import {
  createBrowser,
  signUp,
  reauth,
  createProject,
  createToken,
  startHostedServer,
  tokenCall,
  writeLocalCaptures,
} from './hosted-helpers.js'
import { sampleConfig, tempDir, request } from './helpers.js'

async function fixture(name, options = {}) {
  const hosted = await startHostedServer(name, options)
  const owner = await signUp(hosted, { handle: 'operator-fixture' })
  const ws = owner.workspaceId
  const project = await createProject(owner, ws, 'Fixture')
  const token = await createToken(owner, ws, project.id)
  const config = sampleConfig(`${name}-captures`)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  const pushed = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(pushed.id, area, name, fs.readFileSync(file))
  await remote.commitPush(pushed.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample/captures/manifest.json'))),
    variants: [],
  })
  return { hosted, owner, ws, project, token }
}

test('migration ledger applies missing reservations after version 7, exactly once', async () => {
  // Independent fixture migrations: this remains valid when W6/W7's real
  // reserved migrations land alongside this workstream.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(':memory:')
  try {
    migrate(db, ['CREATE TABLE base_fixture(id INTEGER)', null, null, null, null, null, 'CREATE TABLE ops_fixture(id INTEGER)'])
    assert.deepEqual(
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((x) => x.version),
      [1, 7],
    )
    const future = [null, null, null, null, 'CREATE TABLE w6_fixture(id INTEGER)', 'CREATE TABLE w7_fixture(id INTEGER)']
    migrate(db, future)
    migrate(db, future)
    assert.deepEqual(
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((x) => x.version),
      [1, 5, 6, 7],
    )
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
  } finally {
    db.close()
  }
})

test('operator suspension refuses existing tokens and board writes, preserves reads/export, resume restores token access', async () => {
  const { hosted, owner, ws, project, token } = await fixture('ops-suspension')
  try {
    await owner.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })
    const share = await owner.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, {
      name: 'Guest',
      mode: 'view',
      expiresInDays: 7,
    })
    assert.equal(share.status, 201, share.text)
    const shareToken = new URL(share.json.url).hash.slice(1)
    assert.equal((await owner.browser.call('PATCH', `/api/workspaces/${ws}/public-projects`, { body: { enabled: true } })).status, 200)
    const published = await owner.browser.call('PUT', `/api/workspaces/${ws}/projects/${project.id}/public`, { body: { public: true } })
    assert.equal(published.status, 200, published.text)
    const publicApi = `${published.json.public.url}api/info`
    assert.equal((await owner.browser.get(publicApi)).status, 200)
    suspendWorkspace(hosted.db, { workspaceId: ws, reason: 'Fixture review', operator: 'test' })
    assert.equal((await owner.browser.get(publicApi)).status, 404, 'operator kill switch also stops anonymous public boards')
    assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 401)
    assert.equal((await owner.browser.get(`/api/workspaces/${ws}`)).status, 200)
    assert.equal((await owner.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Forbidden' })).json.error.code, 'workspace_suspended')
    const board = `/w/${ws}/p/${project.id}/api/boards/sample`
    assert.equal((await owner.browser.get(board)).status, 200)
    assert.equal(
      (await owner.browser.post(`${board}/comments`, { pageId: 'home', viewport: 'desktop', body: 'Forbidden', selector: 'p' })).status,
      403,
    )
    assert.equal((await owner.browser.post('/api/shares/preview', { token: shareToken })).status, 404)
    await reauth(owner)
    assert.equal((await owner.browser.post(`/api/workspaces/${ws}/export`, {})).status, 200)
    resumeWorkspace(hosted.db, { workspaceId: ws, operator: 'test' })
    assert.equal((await owner.browser.get(publicApi)).status, 200)
    assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 200)
    assert.deepEqual(
      operatorLog(hosted.db).map((x) => x.action),
      ['resume', 'suspend'],
    )
    assert.equal(listWorkspaces(hosted.db)[0].boards, 1)
  } finally {
    await hosted.close()
  }
})

test('quotas reject invalid config, inherit workspace overrides, and preserve last good edit', () => {
  const ws = 'ws_' + '1'.repeat(24)
  assert.throws(() => parseQuotas('{"default":{"unknown":2}}'), /unknown quota/)
  assert.throws(() => parseQuotas('{"default":{"members":1.2}}'), /whole number/)
  const file = path.join(tempDir('quotas'), 'quotas.json')
  fs.writeFileSync(file, JSON.stringify({ default: { projects: 2 }, workspaces: { [ws]: { storageGB: 1 } } }))
  let now = 10
  const logs = []
  const quotas = createQuotas({ file, checkEveryMs: 0, now: () => ++now, log: (x) => logs.push(x) })
  assert.equal(quotas.of(ws).projects, 2)
  assert.equal(quotas.of(ws).storageBytes, 1024 ** 3)
  fs.writeFileSync(file, '{broken')
  fs.utimesSync(file, new Date(2000), new Date(2000))
  assert.equal(quotas.of(ws).projects, 2)
  assert.ok(logs.some((x) => x.includes('keeping the previous')))
})

test('retention keeps the newest two older captures plus a referenced older version, and updates quota bytes', async () => {
  const { hosted, owner, ws, project } = await fixture('ops-retention')
  try {
    const dir = path.join(hosted.dataDir, 'files', ws, project.id, 'sample', 'versions')
    fs.mkdirSync(dir)
    const versions = Array.from({ length: 5 }, (_, i) => `2026110${i + 1}T100000000Z-ab12`)
    for (const version of versions)
      for (const suffix of ['png', 'thumb.png', 'html']) fs.writeFileSync(path.join(dir, `home.desktop.${version}.${suffix}`), 'fixture')
    // Reference old version using a real comment, then set its historical pin.
    const comment = await owner.browser.post(`/w/${ws}/p/${project.id}/api/boards/sample/comments`, {
      pageId: 'home',
      viewport: 'desktop',
      x: 20,
      y: 20,
      body: 'Keep this',
    })
    assert.equal(comment.status, 201, comment.text)
    hosted.db.prepare('UPDATE comments SET capture_version=? WHERE workspace_id=?').run(versions[0], ws)
    const before = hosted.db.prepare('SELECT bytes FROM boards WHERE workspace_id=?').get(ws).bytes
    assert.equal(runRetention({ db: hosted.db, dataDir: hosted.dataDir, dryRun: true }).files, 6)
    assert.equal(fs.readdirSync(dir).length, 15)
    const result = runRetention({ db: hosted.db, dataDir: hosted.dataDir })
    assert.equal(result.files, 6)
    assert.equal(fs.readdirSync(dir).length, 9)
    assert.ok(fs.existsSync(path.join(dir, `home.desktop.${versions[0]}.png`)))
    assert.equal(hosted.db.prepare('SELECT bytes FROM boards WHERE workspace_id=?').get(ws).bytes, Math.max(0, before - result.bytes))
    assert.deepEqual(planBoardRetention({ home: { desktop: [{ version: 'old', file: 'old.png' }] } }, new Set(), 0), ['old.png'])
  } finally {
    await hosted.close()
  }
})

test('backup restores a live snapshot, boots it and signs in with the fixture passkey', async () => {
  const { hosted, owner, ws } = await fixture('ops-backup')
  let server, db, app
  try {
    fs.writeFileSync(path.join(hosted.dataDir, 'secret.key'), 'fixture-secret-value-for-backup-012345')
    const originalCopy = fs.copyFileSync
    let competingWriteRan = false
    fs.copyFileSync = (...args) => {
      if (!competingWriteRan) {
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);try {db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK')} finally{db.close()}`,
            path.join(hosted.dataDir, 'shapewall.db'),
          ],
          { stdio: 'pipe' },
        )
        competingWriteRan = true
      }
      return originalCopy(...args)
    }
    let saved
    try {
      saved = await backup({ dataDir: hosted.dataDir, to: tempDir('backups') })
    } finally {
      fs.copyFileSync = originalCopy
    }
    assert.equal(competingWriteRan, true, 'the server can write while board files are copied')
    assert.equal(saved.manifest.files.skipped, undefined)
    assert.equal(fs.statSync(saved.dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(saved.dir, 'shapewall.db')).mode & 0o777, 0o600)
    const target = path.join(tempDir('restore-parent'), 'restored')
    await restore({ from: saved.dir, data: target })
    db = await openDatabase(path.join(target, 'shapewall.db'))
    app = createHostedApp({ db, dataDir: target, origin: hosted.origin, secret: 'fixture-secret-value-for-backup-012345', sweepEveryMs: 0 })
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const browser = createBrowser(server.address().port, hosted.origin)
    const options = await browser.post('/auth/login/options', {})
    const signed = await browser.post('/auth/login/verify', { response: owner.authenticator.assert(options.json.options) })
    assert.equal(signed.status, 200, signed.text)
    assert.equal((await browser.get(`/api/workspaces/${ws}`)).status, 200)
    const drill = await restoreDrill({ from: saved.dir })
    assert.equal(drill.ok, true, JSON.stringify(drill.checks))
    const existing = tempDir('keep-existing')
    fs.writeFileSync(path.join(existing, 'keep'), 'must survive')
    await assert.rejects(restoreDrill({ from: saved.dir, scratch: existing }), /already exists/)
    assert.ok(fs.existsSync(path.join(existing, 'keep')))
    await assert.rejects(restore({ from: saved.dir, data: hosted.dataDir }), /not empty/)
    const png = Object.keys(saved.manifest.hashes).find((name) => name.endsWith('.png'))
    fs.appendFileSync(path.join(saved.dir, png), 'damage')
    await assert.rejects(restore({ from: saved.dir, data: path.join(target, 'new') }), /do(?:es)? not match/)
  } finally {
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    await app?.locals.close()
    db?.close()
    await hosted.close()
  }
})

test('backup copies files after the lock: swapped, deleted and pruned board files are listed, not fatal', async () => {
  const { hosted, ws, project } = await fixture('ops-backup-live')
  try {
    const board = path.join(hosted.dataDir, 'files', ws, project.id, 'sample')
    hosted.db
      .prepare(
        `INSERT INTO boards (workspace_id, project_id, board_id, definition, pushed_at, push_count, bytes, created_at)
         SELECT workspace_id, project_id, 'vanish', definition, pushed_at, push_count, bytes, created_at FROM boards WHERE board_id = 'sample'`,
      )
      .run()
    const pruned = 'pricing.phone.png'
    const originalCopy = fs.copyFileSync
    let swapped = false
    let seen = 0
    fs.copyFileSync = (from, ...rest) => {
      if (!swapped) {
        // A push commit lands mid-copy: a new folder is renamed into place.
        // The board after it is deleted meanwhile (rows first, then files).
        swapped = true
        hosted.db.prepare("DELETE FROM boards WHERE board_id = 'vanish'").run()
        fs.cpSync(board, `${board}.next`, { recursive: true })
        fs.renameSync(board, `${board}.prev`)
        fs.renameSync(`${board}.next`, board)
        fs.rmSync(`${board}.prev`, { recursive: true })
      } else if (path.basename(from) === pruned && ++seen === 2) fs.rmSync(from) // deleted during the second copy
      return originalCopy(from, ...rest)
    }
    let saved
    try {
      saved = await backup({ dataDir: hosted.dataDir, to: tempDir('backups-live') })
    } finally {
      fs.copyFileSync = originalCopy
    }
    const rel = `${ws}/${project.id}`
    assert.deepEqual(saved.manifest.files.skipped, {
      vanished: [`${rel}/vanish`],
      changed: [`${rel}/sample`],
      missing: [`${rel}/sample/captures/${pruned}`],
    })
    assert.ok(!fs.existsSync(path.join(saved.dir, 'files', rel, 'sample', 'captures', pruned)))
    const drill = await restoreDrill({ from: saved.dir, out: () => {} })
    assert.equal(drill.ok, true, JSON.stringify(drill.checks))
  } finally {
    await hosted.close()
  }
})

// Runs `onCopyStart` when the backup first looks at the board folder after
// the lock is released (the first look is under the lock).
async function backupWithHook(hosted, board, onCopyStart, to) {
  const originalStat = fs.statSync
  let looks = 0
  fs.statSync = (file, ...rest) => {
    if (file === board && ++looks === 2) onCopyStart()
    return originalStat(file, ...rest)
  }
  try {
    return await backup({ dataDir: hosted.dataDir, to: tempDir(to) })
  } finally {
    fs.statSync = originalStat
  }
}

test('backup: a board folder briefly missing during a push swap is waited for, not called deleted', async () => {
  const { hosted, ws, project } = await fixture('ops-backup-swap-gap')
  try {
    const board = path.join(hosted.dataDir, 'files', ws, project.id, 'sample')
    let restored = null
    const saved = await backupWithHook(
      hosted,
      board,
      () => {
        // The push commit's first rename has run, the second has not yet.
        fs.renameSync(board, `${board}.old`)
        restored = new Promise((resolve) =>
          setTimeout(() => {
            fs.renameSync(`${board}.old`, board)
            resolve()
          }, 120),
        )
      },
      'backups-swap-gap',
    )
    await restored
    assert.equal(saved.manifest.files.skipped, undefined)
    assert.ok(Object.keys(saved.manifest.hashes).some((name) => name.startsWith(`files/${ws}/${project.id}/sample/`)))
    const drill = await restoreDrill({ from: saved.dir, out: () => {} })
    assert.equal(drill.ok, true, JSON.stringify(drill.checks))
  } finally {
    await hosted.close()
  }
})

test('backup: a missing board folder whose row is still live is listed as missing and fails the drill', async () => {
  const { hosted, ws, project } = await fixture('ops-backup-orphan')
  try {
    hosted.db
      .prepare(
        `INSERT INTO boards (workspace_id, project_id, board_id, definition, pushed_at, push_count, bytes, created_at)
         SELECT workspace_id, project_id, 'orphan', definition, pushed_at, push_count, bytes, created_at FROM boards WHERE board_id = 'sample'`,
      )
      .run()
    const saved = await backup({ dataDir: hosted.dataDir, to: tempDir('backups-orphan') })
    const rel = `${ws}/${project.id}`
    assert.deepEqual(saved.manifest.files.skipped, { vanished: [], changed: [], missing: [`${rel}/orphan/`] })
    const drill = await restoreDrill({ from: saved.dir, out: () => {} })
    assert.equal(drill.ok, false)
    assert.ok(drill.checks.some((check) => check.name === 'board folders' && !check.ok))
  } finally {
    await hosted.close()
  }
})

test('backup: a push that commits after the snapshot but before its folder is copied is listed as changed', async () => {
  const { hosted, ws, project } = await fixture('ops-backup-pre-copy')
  try {
    const board = path.join(hosted.dataDir, 'files', ws, project.id, 'sample')
    const saved = await backupWithHook(
      hosted,
      board,
      () => {
        fs.cpSync(board, `${board}.next`, { recursive: true })
        fs.renameSync(board, `${board}.prev`)
        fs.renameSync(`${board}.next`, board)
        fs.rmSync(`${board}.prev`, { recursive: true })
      },
      'backups-pre-copy',
    )
    assert.deepEqual(saved.manifest.files.skipped, { vanished: [], changed: [`${ws}/${project.id}/sample`], missing: [] })
  } finally {
    await hosted.close()
  }
})

test('Funnel rejects console/auth/token routes even with an owner cookie, permits only guest paths', async () => {
  const seen = []
  const server = http.createServer(
    shareOnly((req, res) => {
      seen.push(req.headers.cookie)
      res.end('guest')
    }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const p of ['/signin', '/signup', '/auth/login/options', '/api/workspaces', '/api/v1/project', '/device', '/invite', '/w/ws_fake'])
      assert.equal((await request(server.address().port, 'GET', p)).status, 404, p)
    const guest = await request(server.address().port, 'GET', '/share', {
      headers: { Cookie: '__Host-sw_session=owner; sw_ceremony=secret; sw_guest=guest' },
    })
    assert.equal(guest.status, 200)
    assert.equal(seen[0].trim(), 'sw_guest=guest')
    assert.equal(shareOnlyAllowed('POST', '/uc/x'), false)
    assert.equal(shareOnlyAllowed('GET', '/api/legal'), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Tailscale mocks refuse occupied ports, malformed status and failed Funnel rolls back own Serve only', async () => {
  const status = { BackendState: 'Running', Self: { DNSName: 'fixture.tailnet.ts.net.' }, CertDomains: ['fixture.tailnet.ts.net'] }
  const calls = []
  let active = false
  const run = async (_, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(status) }
    if (args[1] === 'status')
      return {
        code: 0,
        stdout: JSON.stringify(
          active
            ? {
                TCP: { 443: { HTTPS: true } },
                Web: { 'fixture.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4700' } } } },
              }
            : {},
        ),
      }
    if (args[0] === 'funnel') return { code: 1, stderr: 'funnel disabled' }
    active = args.at(-1) !== 'off'
    return { code: 0, stdout: '' }
  }
  await assert.rejects(startTailscale({ localPort: 4700, funnel: { httpsPort: 8443, localPort: 4701 }, run }), /Funnel/)
  assert.ok(calls.includes('serve --https=443 off'))
  active = true
  await assert.rejects(startTailscale({ localPort: 4700, run }), /already serves/)
  await assert.rejects(
    startTailscale({
      localPort: 4700,
      run: async (_, args) => (args[0] === 'status' ? { code: 0, stdout: JSON.stringify(status) } : { code: 0, stdout: 'broken' }),
    }),
    /invalid JSON/,
  )
})

test('setup generation writes locked-down env and examples, refuses overwrite and does not start Docker', async () => {
  const dir = path.join(tempDir('ops-setup'), 'deployment')
  const resolve = { resolve4: async () => ['192.0.2.1'], resolve6: async () => [] }
  const result = await setupHosted({ domain: 'app.example.com', usercontentDomain: 'usercontent.example.net', dir, resolve })
  assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600)
  assert.equal(result.warnings.length, 0)
  await assert.rejects(setupHosted({ domain: 'app.example.com', dir, resolve }), /already has/)
  const examples = path.resolve('examples/hosted')
  assert.equal(fs.readFileSync(path.join(examples, 'compose.yml'), 'utf8'), renderCompose())
  assert.equal(
    fs.readFileSync(path.join(examples, 'Caddyfile.compose'), 'utf8'),
    renderCaddyfile({ domain: 'app.example.com', usercontentDomain: 'usercontent.example.net' }),
  )
  const calls = []
  const started = await startCompose({
    dir,
    run: async (_, args) => {
      calls.push(args)
      return { code: 0, stdout: args.includes('cat') ? 'https://app.example.com/signup#setup=fixture' : '' }
    },
  })
  assert.equal(started.setupLink, 'https://app.example.com/signup#setup=fixture')
  assert.ok(
    calls.every((args) => !args.includes('logs')),
    'setup codes never scraped from logs',
  )
})

test('abuse report records and closing are audited without trusting report HTML', async () => {
  const hosted = await startHostedServer('ops-reports')
  try {
    const made = createReport(hosted.db, {
      url: 'https://app.example.com/share#sensitive',
      reason: 'other',
      details: '<script>x</script>',
      origins: [hosted.origin],
    })
    closeReport(hosted.db, { id: made.id, operator: 'test', note: 'Reviewed' })
    assert.equal(operatorLog(hosted.db)[0].action, 'report_closed')
    const form = await request(hosted.port, 'GET', '/report?url=%22%3E%3Cscript%3Ex%3C/script%3E')
    assert.equal(form.status, 200)
    assert.ok(!form.text.includes('"><script>'))
    assert.match(form.headers['content-security-policy'], /form-action 'self'/)
  } finally {
    await hosted.close()
  }
})

test('a workspace export lists board files removed mid-export instead of failing', async () => {
  const { hosted, ws, project } = await fixture('ops-export-vanish')
  try {
    const t = tenant(hosted.db, ws)
    const iso = () => new Date().toISOString()
    const exported = planWorkspaceExport(t, { dataDir: hosted.dataDir, projects: [project], iso })
    const gone = exported.plan[0].files.find(([relative]) => relative.endsWith('.png'))
    fs.rmSync(gone[1]) // a push swap or retention after the plan
    const chunks = []
    const result = await writeWorkspaceExport(t, exported, {
      write: (b) => chunks.push(Buffer.from(b)),
      now: new Date(),
      iso,
      exportedBy: 'fixture',
    })
    assert.equal(result.skipped, 1)
    const files = readZip(Buffer.concat(chunks))
    const root = Object.keys(files)[0].split('/')[0]
    const skipped = JSON.parse(files[`${root}/skipped-files.json`])
    assert.deepEqual(skipped.files, [`projects/${project.slug}/boards/sample/files/${gone[0]}`])
    assert.ok(!files[`${root}/projects/${project.slug}/boards/sample/files/${gone[0]}`])
    assert.ok(files[`${root}/projects/${project.slug}/boards/sample/board.json`])
  } finally {
    await hosted.close()
  }
})

test('a moving-project login approval respects the project quota and audits the new project', async () => {
  let projects = 1
  const { hosted, owner, ws } = await fixture('ops-device-project', {
    quotas: {
      of: () => ({ projects, members: 5, boardsPerProject: 5, shareLinksPerProject: 5, pushesPerHour: 50, storageBytes: 1024 ** 3 }),
    },
  })
  try {
    const approve = async (name) => {
      const started = await createBrowser(hosted.port, hosted.origin).post('/api/v1/device/start', { name: 'Fixture', purpose: 'import' })
      assert.equal(started.status, 201, started.text)
      return owner.browser.post('/api/device/approve', {
        code: started.json.userCode,
        workspaceId: ws,
        newProjectName: name,
        scopes: ['read', 'push', 'import'],
      })
    }
    const refused = await approve('Over quota')
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.error.code, 'too_many_projects')
    assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?').get(ws).n, 1)
    projects = 2
    const made = await approve('Moved in')
    assert.equal(made.status, 200, made.text)
    const logged = hosted.db.prepare("SELECT target FROM audit_log WHERE workspace_id = ? AND action = 'project_created'").all(ws)
    assert.ok(logged.some((row) => row.target === made.json.project.id))
  } finally {
    await hosted.close()
  }
})

test('workspace quotas are enforced at the project, share, member and push HTTP boundaries', async () => {
  const { hosted, owner, ws, project, token } = await fixture('ops-quota-boundaries', {
    quotas: {
      of: () => ({ projects: 1, members: 1, boardsPerProject: 1, shareLinksPerProject: 0, pushesPerHour: 1, storageBytes: 1024 ** 3 }),
    },
  })
  try {
    assert.equal((await owner.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Overflow' })).json.error.code, 'too_many_projects')
    await owner.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })
    assert.equal(
      (await owner.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { name: 'Overflow', mode: 'view' })).status,
      409,
    )
    const made = await owner.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member' })
    assert.equal(made.status, 201, made.text)
    await assert.rejects(signUp(hosted, { handle: 'overflow-member', invite: new URL(made.json.url).hash.slice(1) }), /workspace_full/)
    const config = sampleConfig('ops-push-limit')
    const result = await tokenCall(hosted, token, 'POST', '/api/v1/pushes', pushDefinition(config, config.boards[0]))
    assert.equal(result.status, 429, result.text)
  } finally {
    await hosted.close()
  }
})

test('operator CLI logs reads, rejects wrong deletion confirmation, and removes fixture data on confirmed deletion', async () => {
  const { hosted, ws, project } = await fixture('ops-cli-audit')
  try {
    const { hostedCommand } = await import('../src/hosted/ops-cli.js')
    const lines = []
    const flags = { data: hosted.dataDir, json: true, operator: 'fixture-operator' }
    assert.equal(await hostedCommand(['admin', 'list'], flags, (x) => lines.push(x)), 0)
    assert.equal(JSON.parse(lines[0])[0].id, ws)
    assert.equal(operatorLog(hosted.db)[0].action, 'list')
    assert.equal(await hostedCommand(['admin', 'delete', ws], { ...flags, confirm: 'wrong' }, () => {}), 1)
    assert.ok(fs.existsSync(path.join(hosted.dataDir, 'files', ws, project.id)))
    const name = listWorkspaces(hosted.db)[0].name
    assert.equal(await hostedCommand(['admin', 'delete', ws], { ...flags, confirm: name }, () => {}), 0)
    assert.equal(listWorkspaces(hosted.db).length, 0)
    assert.equal(fs.existsSync(path.join(hosted.dataDir, 'files', ws)), false)
    assert.equal(operatorLog(hosted.db)[0].action, 'delete')
  } finally {
    await hosted.close()
  }
})

test('systemd and file credentials load without logging their contents', async () => {
  const { loadCredentials } = await import('../src/hosted/server.js')
  const dir = tempDir('ops-credentials')
  const fixtureValue = 'synthetic-key-not-a-real-secret-0123456789'
  fs.writeFileSync(path.join(dir, 'shapewall-secret'), fixtureValue)
  const env = { CREDENTIALS_DIRECTORY: dir }
  assert.deepEqual(loadCredentials(env), ['SHAPEWALL_HOSTED_SECRET'])
  assert.equal(env.SHAPEWALL_HOSTED_SECRET, fixtureValue)
  env.SHAPEWALL_HOSTED_SECRET = 'explicit-fixture-value'
  assert.deepEqual(loadCredentials(env), [])
  assert.equal(env.SHAPEWALL_HOSTED_SECRET, 'explicit-fixture-value')
  assert.throws(() => loadCredentials({ SHAPEWALL_HOSTED_SECRET_FILE: path.join(dir, 'missing') }), /cannot read/)
})

test('secondary guest listener cannot mint setup codes', async () => {
  const dataDir = tempDir('ops-secondary')
  const db = await openDatabase(path.join(dataDir, 'shapewall.db'))
  db.prepare('INSERT INTO server_state(key, value, updated_at) VALUES (?, ?, ?)').run(
    'origin',
    JSON.stringify({ origin: 'https://canonical.example.com' }),
    new Date().toISOString(),
  )
  let app
  try {
    app = createHostedApp({
      db,
      dataDir,
      origin: 'https://fixture.tailnet.ts.net:8443',
      secret: 'synthetic-key-not-a-real-secret-0123456789',
      guestOnly: true,
      sweepEveryMs: 0,
    })
    assert.equal(app.locals.setupLink(), null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get().n, 0)
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT value FROM server_state WHERE key='origin'").get().value),
      {
        origin: 'https://canonical.example.com',
      },
      'the public listener must not overwrite the primary passkey origin',
    )
  } finally {
    await app?.locals.close()
    db.close()
  }
})
