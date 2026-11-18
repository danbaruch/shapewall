// Review finding 04: a push that replaces a hosted board rebuilt its capture
// history from the sender's files only. A sender that keeps less history
// (a second checkout, CI) removed the screenshot a hosted comment was pinned
// to, or a reply's drawing was made on. The commit now carries those
// versions over from the board it replaces, and counts their bytes once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig } from './helpers.js'

const solidPng = ([r, g, b]) => {
  const png = new PNG({ width: 8, height: 6 })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i)
  return PNG.sync.write(png)
}
const pixels = (bytes) => PNG.sync.read(bytes).data.toString('hex')

async function push(remote, config) {
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, board.id, 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
}

// A checkout whose current captures are `color` at `version`, with `older`
// ({ version: color }) in its history.
function checkout(name, version, color, older = {}) {
  const config = sampleConfig(name)
  const dir = writeLocalCaptures(config, 'sample')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  for (const [pageId, views] of Object.entries(manifest.pages))
    for (const [viewport, entry] of Object.entries(views)) {
      entry.version = version
      fs.writeFileSync(path.join(dir, `${pageId}.${viewport}.png`), solidPng(color))
    }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  const versions = path.join(config.outputDir, 'sample', 'versions')
  for (const [old, oldColor] of Object.entries(older)) {
    fs.mkdirSync(versions, { recursive: true })
    fs.writeFileSync(path.join(versions, `home.desktop.${old}.png`), solidPng(oldColor))
  }
  return config
}

test('a push from a checkout with less history keeps every version a hosted comment or reply drawing points at', async () => {
  const hosted = await startHostedServer('push-history')
  try {
    const owner = await signUp(hosted, { handle: 'hist' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const OLDEST = '20261020T100000000Z-aaaa'
    const FIRST = '20261101T100000000Z-ab12'
    const SECOND = '20261117T100000000Z-bbbb'
    const DRAWN = '20261015T100000000Z-eeee'
    const UNPINNED = '20261010T100000000Z-cccc'
    const RED = [200, 0, 0]
    const BLUE = [0, 0, 200]
    const GREEN = [0, 200, 0]
    const GREY = [90, 90, 90]
    const GOLD = [200, 160, 0]
    // The first checkout: home is red now; blue, gold and grey before.
    await push(remote, checkout('push-history-a', FIRST, RED, { [OLDEST]: BLUE, [DRAWN]: GOLD, [UNPINNED]: GREY }))
    const stored = (...parts) => path.join(hosted.dataDir, 'files', ws, project.id, 'sample', ...parts)
    assert.ok(fs.existsSync(stored('versions', `home.desktop.${OLDEST}.png`)))
    // Hosted discussion: a comment pinned to the current (red) capture, one
    // to the blue history, and on that one a reply drawn on the gold one.
    const board = `/w/${ws}/p/${project.id}/api/boards/sample`
    const made = []
    for (const body of ['On the red one', 'On the blue one']) {
      const comment = await owner.browser.post(`${board}/comments`, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body })
      assert.equal(comment.status, 201, comment.text)
      made.push(comment.json.comment.id)
    }
    const pin = hosted.db.prepare('UPDATE comments SET capture_version = ? WHERE workspace_id = ? AND number = ?')
    pin.run(FIRST, ws, made[0])
    pin.run(OLDEST, ws, made[1])
    hosted.db
      .prepare('UPDATE comments SET replies = ? WHERE workspace_id = ? AND number = ?')
      .run(JSON.stringify([{ id: 1, body: 'drawn', drawing: { captureVersion: DRAWN, strokes: [] } }]), ws, made[1])
    const before = hosted.db.prepare('SELECT bytes FROM boards WHERE workspace_id = ?').get(ws).bytes
    // A second checkout: green now, and no history at all.
    await push(remote, checkout('push-history-b', SECOND, GREEN))
    // The current capture is the new one; the pinned versions are the same pixels as before.
    assert.equal(pixels(fs.readFileSync(stored('captures', 'home.desktop.png'))), pixels(solidPng(GREEN)))
    for (const [version, color] of [
      [FIRST, RED],
      [OLDEST, BLUE],
      [DRAWN, GOLD],
    ]) {
      const file = stored('versions', `home.desktop.${version}.png`)
      assert.ok(fs.existsSync(file), `${version} is still there`)
      assert.equal(pixels(fs.readFileSync(file)), pixels(solidPng(color)), `${version}: the same pixels`)
      const served = await owner.browser.get(`${board}/versions/home.desktop.${version}.png`)
      assert.equal(served.status, 200, `${version} is served`)
    }
    // History nothing points at follows the sender, as before.
    assert.ok(!fs.existsSync(stored('versions', `home.desktop.${UNPINNED}.png`)))
    // The carried bytes are in the board's count, once.
    const carried = [FIRST, OLDEST, DRAWN].reduce((n, version) => {
      let sum = 0
      for (const suffix of ['.png', '.thumb.png', '.html']) {
        const file = stored('versions', `home.desktop.${version}${suffix}`)
        if (fs.existsSync(file)) sum += fs.statSync(file).size
      }
      return n + sum
    }, 0)
    const row = hosted.db.prepare('SELECT bytes FROM boards WHERE workspace_id = ?').get(ws)
    assert.ok(carried > 0)
    const pushed = hosted.db
      .prepare("SELECT bytes FROM pushes WHERE workspace_id = ? AND status = 'committed' ORDER BY finished_at DESC")
      .get(ws)
    assert.equal(row.bytes, pushed.bytes + carried, `board bytes: ${before} before`)
    // A third push carries them again, and does not count them twice.
    await push(remote, checkout('push-history-c', '20261118T100000000Z-dddd', GREEN))
    assert.ok(fs.existsSync(stored('versions', `home.desktop.${FIRST}.png`)))
    const third = hosted.db
      .prepare("SELECT bytes FROM pushes WHERE workspace_id = ? AND status = 'committed' ORDER BY finished_at DESC")
      .get(ws)
    const again = hosted.db.prepare('SELECT bytes FROM boards WHERE workspace_id = ?').get(ws).bytes
    const now = [FIRST, OLDEST, DRAWN].reduce((n, version) => {
      let sum = 0
      for (const suffix of ['.png', '.thumb.png', '.html']) {
        const file = stored('versions', `home.desktop.${version}${suffix}`)
        if (fs.existsSync(file)) sum += fs.statSync(file).size
      }
      return n + sum
    }, 0)
    assert.equal(again, third.bytes + now)
  } finally {
    await hosted.close()
  }
})

// Review follow-up to 04: a carried version is copied under a temporary name
// and renamed when whole, so a crash mid-copy never leaves a cut-short file
// under a name the retried push installs; such a leftover is not installed.
test('carried versions are copied whole or not at all, and a cut-short leftover is never installed', async () => {
  const hosted = await startHostedServer('push-carry-temp')
  try {
    const owner = await signUp(hosted, { handle: 'carry' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const OLDEST = '20261020T100000000Z-aaaa'
    await push(remote, checkout('carry-temp-a', '20261101T100000000Z-ab12', [200, 0, 0], { [OLDEST]: [0, 0, 200] }))
    const board = `/w/${ws}/p/${project.id}/api/boards/sample`
    const made = await owner.browser.post(`${board}/comments`, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Blue' })
    assert.equal(made.status, 201, made.text)
    hosted.db.prepare('UPDATE comments SET capture_version = ? WHERE workspace_id = ? AND number = ?').run(OLDEST, ws, made.json.comment.id)
    // The next push, uploaded; a crashed earlier commit of it left a cut-short copy behind.
    const config = checkout('carry-temp-b', '20261117T100000000Z-bbbb', [0, 200, 0])
    const sample = config.boards[0]
    const started = await remote.startPush(pushDefinition(config, sample))
    for (const [area, name, file] of pushFiles(config, sample)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const stagedVersions = path.join(hosted.dataDir, 'staging', started.id, 'versions')
    fs.mkdirSync(stagedVersions, { recursive: true })
    fs.writeFileSync(path.join(stagedVersions, `home.desktop.${OLDEST}.png.carrying`), 'cut sh')
    const copies = []
    const originalCopy = fs.copyFileSync
    fs.copyFileSync = (from, to, ...rest) => {
      copies.push(String(to))
      return originalCopy(from, to, ...rest)
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
      await remote.commitPush(started.id, { manifest, variants: [] })
    } finally {
      fs.copyFileSync = originalCopy
    }
    const carriedCopies = copies.filter((file) => file.includes(`${path.sep}staging${path.sep}`))
    assert.ok(carriedCopies.length > 0, 'something was carried')
    assert.ok(
      carriedCopies.every((file) => file.endsWith('.carrying')),
      `never straight to its final name: ${carriedCopies.join(', ')}`,
    )
    const stored = path.join(hosted.dataDir, 'files', ws, project.id, 'sample', 'versions')
    assert.deepEqual(
      fs.readdirSync(stored).filter((name) => name.endsWith('.carrying')),
      [],
      'no temporary file installed',
    )
    assert.equal(pixels(fs.readFileSync(path.join(stored, `home.desktop.${OLDEST}.png`))), pixels(solidPng([0, 0, 200])))
  } finally {
    await hosted.close()
  }
})
