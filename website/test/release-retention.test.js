// Tests for the release retention script against throwaway lane trees (no droplet, no root needed).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../deploy/release-retention.sh', import.meta.url))
const DAY = 86400

function lane() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'))
  fs.mkdirSync(path.join(root, 'lane', 'releases'), { recursive: true })
  fs.mkdirSync(path.join(root, 'config'))
  return { root, dir: path.join(root, 'lane'), config: path.join(root, 'config') }
}

function ageTree(p, seconds) {
  // set mtimes of p and everything in it to `seconds` ago
  const t = Date.now() / 1000 - seconds
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) ageTree(path.join(p, e.name), seconds)
    else fs.utimesSync(path.join(p, e.name), t, t)
  }
  fs.utimesSync(p, t, t)
}

function release(l, name, { age = 2 * DAY, files = { 'index.html': name } } = {}) {
  const d = path.join(l.dir, 'releases', name)
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true })
    fs.writeFileSync(path.join(d, f), body)
  }
  ageTree(d, age)
  return d
}

function link(l, name, target) {
  fs.symlinkSync(target, path.join(l.dir, name))
}

function run(l, ...args) {
  const r = spawnSync('bash', [SCRIPT, ...args, l.dir], {
    encoding: 'utf8',
    env: { ...process.env, RETENTION_CONFIG_DIRS: l.config },
  })
  return { ...r, out: r.stdout + r.stderr }
}

const names = (l) => fs.readdirSync(path.join(l.dir, 'releases')).sort()
const stamp = (i) => `202611${String(10 + i).padStart(2, '0')}T120000Z-abc${i}`

test('keeps current, previous and one more; dry run deletes nothing', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  for (let i = 1; i <= 6; i++) release(l, stamp(i))
  link(l, 'current', `releases/${stamp(6)}`)
  link(l, 'previous', `releases/${stamp(5)}`)

  const dry = run(l, '--dry-run')
  assert.equal(dry.status, 0, dry.out)
  assert.match(dry.out, /would prune 3 release/)
  assert.equal(names(l).length, 6)

  const real = run(l)
  assert.equal(real.status, 0, real.out)
  assert.deepEqual(names(l), [stamp(4), stamp(5), stamp(6)])
  assert.match(real.out, /pruned 3 release\(s\) and 0 backup\(s\)/)
})

test('a previous that is not among the newest still counts toward the three', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  for (let i = 1; i <= 5; i++) release(l, stamp(i))
  link(l, 'current', `releases/${stamp(5)}`)
  link(l, 'previous', `releases/${stamp(1)}`) // a rollback made the oldest one previous
  assert.equal(run(l).status, 0)
  assert.deepEqual(names(l), [stamp(1), stamp(4), stamp(5)])
})

test('safety rules keep releases and say why', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  release(l, stamp(1), { files: { 'data/app.db': 'x' } })
  release(l, stamp(2))
  fs.writeFileSync(path.join(l.config, 'site.caddy'), `root * /x/releases/${stamp(2)}\n`)
  release(l, stamp(3), { files: { 'public/uploads/a.png': 'old upload' } })
  release(l, stamp(4), { age: 600 }) // touched ten minutes ago
  release(l, stamp(5), { files: { 'x.sqlite-wal': 'x' } })
  release(l, stamp(6), { files: { 'public/uploads/a.png': 'current upload' } })
  release(l, stamp(7), { files: { 'public/uploads/a.png': 'current upload' } })
  release(l, stamp(8), { files: { 'public/uploads/a.png': 'current upload' } })
  release(l, stamp(9)) // newer than current: a failed release kept for inspection
  link(l, 'current', `releases/${stamp(8)}`)
  link(l, 'previous', `releases/${stamp(7)}`)

  const r = run(l)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`keep  ${stamp(1)}: holds database file data/app.db`))
  assert.match(r.out, new RegExp(`keep  ${stamp(2)}: named in .*site.caddy`))
  assert.match(r.out, new RegExp(`keep  ${stamp(3)}: holds public/uploads, which differs`))
  assert.match(r.out, new RegExp(`keep  ${stamp(4)}: modified in the last`))
  assert.match(r.out, new RegExp(`keep  ${stamp(5)}: holds database file`))
  assert.match(r.out, new RegExp(`keep  ${stamp(9)}: newer than current`))
  // 8 current, 7 previous, 6 = the third slot; every older one was protected by a rule
  assert.equal(names(l).length, 9)
})

test('a file in the lane root (deployment manifest) protects the release it names', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  for (let i = 1; i <= 4; i++) release(l, stamp(i))
  link(l, 'current', `releases/${stamp(4)}`)
  link(l, 'previous', `releases/${stamp(3)}`)
  fs.writeFileSync(path.join(l.dir, 'deployment.json'), JSON.stringify({ rollback: stamp(1) }))
  assert.equal(run(l).status, 0)
  assert.deepEqual(names(l), [stamp(1), stamp(2), stamp(3), stamp(4)])
})

test('sha-named releases with .previous-<sha> links: newest kept by RELEASED_AT, dangling links removed', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  const shas = ['aaa1111', 'bbb2222', 'ccc3333', 'ddd4444', 'eee5555']
  shas.forEach((s, i) => release(l, s, { files: { RELEASED_AT: `2026-11-${10 + i}T12:00:00Z\n`, 'server.js': s } }))
  const abs = (s) => path.join(l.dir, 'releases', s)
  link(l, 'current', abs('eee5555'))
  for (let i = 1; i < shas.length; i++) link(l, `.previous-${shas[i]}`, abs(shas[i - 1]))

  const r = run(l)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(names(l), ['ccc3333', 'ddd4444', 'eee5555'])
  const links = fs
    .readdirSync(l.dir)
    .filter((n) => n.startsWith('.previous-'))
    .sort()
  assert.deepEqual(links, ['.previous-ddd4444', '.previous-eee5555'])
})

test('a symlink in --link-dir (legacy pointer dir) protects its target', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  for (let i = 1; i <= 5; i++) release(l, stamp(i))
  link(l, 'current', `releases/${stamp(5)}`)
  link(l, 'previous', `releases/${stamp(4)}`)
  const legacy = path.join(l.root, 'legacy')
  fs.mkdirSync(legacy)
  fs.symlinkSync(path.join(l.dir, 'releases', stamp(1)), path.join(legacy, 'old'))
  assert.equal(run(l, '--link-dir', legacy).status, 0)
  // the pinned release counts as live, so it takes the third slot
  assert.deepEqual(names(l), [stamp(1), stamp(4), stamp(5)])
})

test('backups: newest five pre-<rev>-<stamp> dirs kept, anything else in backups/ left alone', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  release(l, stamp(1))
  link(l, 'current', `releases/${stamp(1)}`)
  const b = path.join(l.dir, 'backups')
  fs.mkdirSync(b)
  const made = []
  for (let i = 1; i <= 8; i++) {
    const n = `pre-abc${i}def-202611${String(10 + i)}T120000Z`
    fs.mkdirSync(path.join(b, n))
    fs.writeFileSync(path.join(b, n, 'store.json'), '{}')
    ageTree(path.join(b, n), 2 * DAY)
    made.push(n)
  }
  fs.mkdirSync(path.join(b, 'pre-c012fe3')) // older naming: not ours to judge
  fs.writeFileSync(path.join(b, 'store-before-mock.json'), '{}')
  fs.symlinkSync('/nonexistent', path.join(b, 'pre-0000000-20260101T000000Z'))

  const r = run(l)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(
    fs.readdirSync(b).sort(),
    [...made.slice(3), 'pre-0000000-20260101T000000Z', 'pre-c012fe3', 'store-before-mock.json'].sort(),
  )
  assert.match(r.out, /3 backup\(s\)/)
})

test('a missing current prunes nothing and still exits 0', (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  for (let i = 1; i <= 5; i++) release(l, stamp(i))
  link(l, 'current', 'releases/gone')
  const r = run(l)
  assert.equal(r.status, 0)
  assert.match(r.out, /nothing pruned/)
  assert.equal(names(l).length, 5)
})

test('a release a process runs from is kept', async (t) => {
  const l = lane()
  t.after(() => fs.rmSync(l.root, { recursive: true, force: true }))
  for (let i = 1; i <= 4; i++) release(l, stamp(i))
  link(l, 'current', `releases/${stamp(4)}`)
  link(l, 'previous', `releases/${stamp(3)}`)
  const { spawn } = await import('node:child_process')
  const p = spawn('sleep', ['30'], { cwd: path.join(l.dir, 'releases', stamp(1)) })
  t.after(() => p.kill())
  await new Promise((r) => setTimeout(r, 200))
  const r = run(l)
  assert.match(r.out, new RegExp(`keep  ${stamp(1)}: in use by a running process`))
  assert.deepEqual(names(l), [stamp(1), stamp(2), stamp(3), stamp(4)])
})

test('deploy.sh prunes with this script only after the smoke checks, and keeps no prune of its own', () => {
  const deploy = fs.readFileSync(fileURLToPath(new URL('../deploy/deploy.sh', import.meta.url)), 'utf8')
  assert.doesNotMatch(deploy, /head -n -5|xargs -r rm -rf/, 'the old unchecked prune is gone')
  assert.match(deploy, /<deploy\/release-retention\.sh/, 'the retention script is what runs on the host')
  const tail = deploy.slice(deploy.lastIndexOf('echo "released'))
  assert.match(tail, /^echo "released \$STAMP"\nsmoke\nprune\n$/, 'release, then smoke checks, then retention')
  assert.match(deploy, /\|\| echo "\[retention\] WARNING/, 'a retention failure only warns')
})
