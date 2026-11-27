// The local board's one-use open pages (src/open-page.js): rev55 L1 and L2.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SETTINGS_TOKEN_KEY, createOpenPages } from '../src/open-page.js'
import { tempDir } from './helpers.js'

const made = []
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

test('L2: pages a stopped server left behind are removed when the next one starts, not only at the next --open', () => {
  const dir = tempDir('open-pages-sweep')
  made.push(dir)
  // A process that is gone: its pid, once it has exited.
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const deadPid = Number(gone.stdout)
  assert.ok(deadPid > 0)
  const page = (name, ageMs = 0) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'x', { mode: 0o600 })
    if (ageMs) {
      const at = new Date(Date.now() - ageMs)
      fs.utimesSync(file, at, at)
    }
    return file
  }
  const dead = page(`open-${deadPid}-0123456789abcdef.html`)
  const live = page(`open-${process.ppid}-0123456789abcdef.html`)
  const staleLive = page(`open-${process.ppid}-fedcba9876543210.html`, 10 * 60_000)
  const oldFresh = page('open-00112233445566ff.html')
  const oldStale = page('open-aabbccddeeff0011.html', 10 * 60_000)
  const other = page('notes.html', 10 * 60_000)
  // Only made: no page is minted.
  const pages = createOpenPages({ dir, ttlMs: 60_000, keepMs: 5 * 60_000 })
  assert.equal(fs.existsSync(dead), false, 'the page of a process that is gone')
  assert.equal(fs.existsSync(staleLive), false, 'a page older than any page can work')
  assert.equal(fs.existsSync(oldStale), false, 'an old-style page older than any page can work')
  assert.equal(fs.existsSync(live), true, 'a new page of a live process (another server for the project)')
  assert.equal(fs.existsSync(oldFresh), true, 'a new old-style page (its process is unknown)')
  assert.equal(fs.existsSync(other), true, 'not a page')
  // A page it makes carries its pid, and goes at stop.
  const file = fileURLToPath(pages.mint('http://127.0.0.1:9/open'))
  assert.match(path.basename(file), new RegExp(`^open-${process.pid}-[a-f0-9]{16}\\.html$`))
  pages.close()
  assert.equal(fs.existsSync(file), false)
})

test('L1: the board reads the token from the same sessionStorage key the hand-off page writes', () => {
  const api = fs.readFileSync(fileURLToPath(new URL('../client/src/lib/api.js', import.meta.url)), 'utf8')
  assert.match(api, new RegExp(`const TOKEN_KEY = '${SETTINGS_TOKEN_KEY}'`))
})
