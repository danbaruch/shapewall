// deploy.sh checks its whole argument list before it does anything. Every tool it could reach (ssh, curl, npm, node, tar,
// git) is a stub that only records that it ran, so nothing here builds, uploads or touches a server.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../deploy/deploy.sh', import.meta.url))
const TOOLS = ['ssh', 'scp', 'rsync', 'curl', 'npm', 'npx', 'node', 'tar', 'git']

// real: tools that run for real (still logged), e.g. node to read a fixture manifest. bodies: a tool's own stub script.
function stubs(t, { dirtyTree = false, real = [], bodies = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-args-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'calls.log')
  for (const tool of TOOLS) {
    // git status reports a change when asked, so a release stops at its first check.
    let body = tool === 'git' && dirtyTree ? 'echo " M somefile"' : 'true'
    if (real.includes(tool)) body = `exec ${spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()} "$@"`
    if (bodies[tool]) body = bodies[tool]
    fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env bash\necho "${tool} $*" >>"${log}"\n${body}\n`, { mode: 0o755 })
  }
  const run = (...args) => {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DEPLOY_HOST: 'deploy-stub.invalid',
        SHAPEWALL_SITE_URL: 'http://127.0.0.1:9',
        SHAPEWALL_DEMO: '0',
        ...env,
      },
    })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    fs.rmSync(log, { force: true })
    return { status: result.status, out: result.stdout + result.stderr, calls }
  }
  return run
}

test('help prints the usage and runs nothing', (t) => {
  const run = stubs(t)
  for (const flag of ['--help', '-h', 'help']) {
    const result = run(flag)
    assert.equal(result.status, 0, flag)
    assert.match(result.out, /usage: deploy\.sh/)
    assert.deepEqual(result.calls, [], flag)
  }
})

test('an unknown command or a stray flag is refused before any tool runs', (t) => {
  const run = stubs(t)
  for (const args of [
    ['smok'],
    ['prun'],
    ['rolback'],
    ['--dry-run', 'extra'],
    ['media', '--force'],
    ['media', 'now'],
    ['media-prune', '--force'],
    ['media-prune', '--yes', '--dry-run'],
    ['media-prune', 'yes'],
    ['release'],
    ['deploy'],
    ['smoke', '--dry-run'],
    ['rollback', 'now'],
    ['prune', '--force'],
    ['prune', '--dry-run', 'extra'],
    ['--help', 'smoke'],
    [''],
  ]) {
    const result = run(...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.out, /unknown command or option/)
    assert.deepEqual(result.calls, [], `no tool runs for: ${args.join(' ')}`)
  }
})

test('the read-only commands reach only their own tools', (t) => {
  const run = stubs(t)
  const smoke = run('smoke')
  assert.ok(smoke.calls.length > 0 && smoke.calls.every((call) => call.startsWith('curl ')), smoke.calls.join('\n'))
  const prune = run('prune', '--dry-run')
  assert.equal(prune.status, 0)
  assert.equal(prune.calls.length, 1)
  assert.match(prune.calls[0], /^ssh deploy-stub\.invalid bash -s -- --dry-run --keep 3/)
})

test('no arguments still means a release (stopped here at the clean-tree check)', (t) => {
  const run = stubs(t, { dirtyTree: true })
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.out, /uncommitted changes/)
  assert.deepEqual(result.calls, ['git status --porcelain -- ..'])
})

// The videos: a fixture manifest with three hashed files and a local media folder, and (for uploads) a fake host, a
// folder that stands in for /var/www/shapewall.com: the ssh stub runs the remote command locally with that path
// swapped in, so the real find/tar/mv logic runs against throwaway files and nothing leaves this machine.
const MEDIA_FILES = {
  'launch-film-1080.0123456789.mp4': 'film bytes',
  'launch-film-poster.abcdef0123.jpg': 'poster',
  'tour-captions-en.9876543210.vtt': 'WEBVTT\n',
}
function mediaFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-media-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const local = path.join(dir, 'media')
  const host = path.join(dir, 'host')
  fs.mkdirSync(local)
  fs.mkdirSync(host)
  for (const [name, body] of Object.entries(MEDIA_FILES)) fs.writeFileSync(path.join(local, name), body)
  const entry = (name) => ({ file: name, bytes: Buffer.byteLength(MEDIA_FILES[name]) })
  const [mp4, jpg, vtt] = Object.keys(MEDIA_FILES)
  const manifest = {
    base: '/media/',
    videos: {
      'launch-film': {
        kind: 'film',
        sources: [{ ...entry(mp4), type: 'video/mp4', height: 1080 }],
        poster: { jpg: entry(jpg), webp: [] },
        tracks: [{ ...entry(vtt), kind: 'subtitles' }],
      },
    },
  }
  const manifestPath = path.join(dir, 'media.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const env = { SHAPEWALL_MEDIA_DIR: local, SHAPEWALL_MEDIA_MANIFEST: manifestPath, FAKE_HOST: host }
  return { local, host, env }
}
// ssh <host> <command>: run <command> here, on the fake host folder.
const FAKE_SSH = 'cmd="$2"; cmd="${cmd//\\/var\\/www\\/shapewall.com/$FAKE_HOST}"; exec bash -c "$cmd"'

test('--dry-run prints the whole release plan, with every media file and where it goes, and runs nothing remote', (t) => {
  const { env } = mediaFixture(t)
  const run = stubs(t, { real: ['node'], env })
  const result = run('--dry-run')
  assert.equal(result.status, 0, result.out)
  for (const name of Object.keys(MEDIA_FILES)) {
    assert.ok(result.out.includes(`media/${name} -> deploy-stub.invalid:/var/www/shapewall.com/media/${name}`), name)
  }
  assert.match(result.out, /links \/var\/www\/shapewall\.com\/releases\/[^ ]+\/media -> \.\.\/\.\.\/media/)
  assert.match(result.out, /nothing was built, uploaded or switched/)
  const remote = result.calls.filter((call) => /^(ssh|scp|rsync|tar|npm|npx|curl) /.test(call))
  assert.deepEqual(remote, [], 'no build, upload or network call')
})

test('media --dry-run prints the plan; a file missing locally stops it before anything is sent', (t) => {
  const { local, env } = mediaFixture(t)
  const run = stubs(t, { real: ['node'], env })
  const plan = run('media', '--dry-run')
  assert.equal(plan.status, 0, plan.out)
  assert.match(plan.out, /3 files, \d+ bytes at most/)
  assert.ok(!plan.calls.some((call) => call.startsWith('ssh ')))
  fs.rmSync(path.join(local, 'launch-film-poster.abcdef0123.jpg'))
  for (const args of [['media'], ['media', '--dry-run']]) {
    const result = run(...args)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.out, /missing {5}launch-film-poster\.abcdef0123\.jpg/)
    assert.ok(!result.calls.some((call) => /^(ssh|tar) /.test(call)), `${args.join(' ')}: nothing sent`)
  }
})

test('media uploads only what the host lacks, replaces a wrong-sized file and never deletes one', (t) => {
  const { host, env } = mediaFixture(t)
  fs.mkdirSync(path.join(host, 'media'))
  fs.writeFileSync(path.join(host, 'media', 'launch-film-1080.0123456789.mp4'), 'film bytes') // already there
  fs.writeFileSync(path.join(host, 'media', 'tour-captions-en.9876543210.vtt'), 'half') // a broken earlier copy
  fs.writeFileSync(path.join(host, 'media', 'old-film-1080.1111111111.mp4'), 'an older release still uses this')
  const run = stubs(t, { real: ['node', 'tar'], bodies: { ssh: FAKE_SSH }, env })
  const first = run('media')
  assert.equal(first.status, 0, first.out)
  assert.match(first.out, /uploading 2 of 3 files/)
  assert.match(first.out, /all 3 files on the host, sizes checked/)
  for (const [name, body] of Object.entries(MEDIA_FILES)) assert.equal(fs.readFileSync(path.join(host, 'media', name), 'utf8'), body, name)
  assert.ok(fs.existsSync(path.join(host, 'media', 'old-film-1080.1111111111.mp4')), 'older files stay')
  assert.deepEqual(
    fs.readdirSync(path.join(host, 'media')).filter((name) => name.startsWith('.')),
    [],
    'no temporary folder left behind',
  )
  const tarCalls = first.calls.filter((call) => call.startsWith('tar ') && call.includes(' -cf '))
  assert.equal(tarCalls.length, 1)
  assert.ok(!tarCalls[0].includes('launch-film-1080.0123456789.mp4'), 'a file the host has is not sent again')
  const second = run('media')
  assert.equal(second.status, 0, second.out)
  assert.match(second.out, /the host has all 3 files/)
  assert.ok(!second.calls.some((call) => call.startsWith('tar ')), 'nothing to send')
})

test('media fails when the host still lacks a file after the upload', (t) => {
  const { env } = mediaFixture(t)
  // A host that accepts the upload but keeps nothing (a full disk, say).
  const run = stubs(t, { real: ['node', 'tar'], bodies: { ssh: 'cat >/dev/null; true' }, env })
  const result = run('media')
  assert.equal(result.status, 1)
  assert.match(result.out, /FAIL on the host: launch-film-1080\.0123456789\.mp4 missing or wrong size/)
  assert.match(result.out, /nothing was released/)
})

// media-prune on a fake host: releases with the manifests they were built with, a shared media folder.
function pruneHost(t) {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-prune-'))
  t.after(() => fs.rmSync(host, { recursive: true, force: true }))
  const media = path.join(host, 'media')
  fs.mkdirSync(media)
  const old = new Date(Date.now() - 24 * 3600 * 1000)
  const file = (name, { recent = false } = {}) => {
    fs.writeFileSync(path.join(media, name), name)
    if (!recent) fs.utimesSync(path.join(media, name), old, old)
  }
  const release = (stamp, files, { manifest = true } = {}) => {
    const dir = path.join(host, 'releases', stamp)
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync('../../media', path.join(dir, 'media'))
    if (manifest) {
      const sources = files.map((name) => ({ file: name, bytes: name.length, type: 'video/mp4', height: 720 }))
      fs.writeFileSync(
        path.join(dir, '.media-manifest.json'),
        JSON.stringify({ videos: { x: { sources, poster: { webp: [] } } } }, null, 2),
      )
    }
  }
  // An older release from before the videos: no media link, no manifest.
  fs.mkdirSync(path.join(host, 'releases', '20261101T000000Z-aaaaaaa'), { recursive: true })
  release('20261117T000000Z-bbbbbbb', ['film-720.1111111111.mp4', 'film-poster.2222222222.jpg'])
  release('20261118T000000Z-ccccccc', ['film-720.3333333333.mp4', 'film-poster.2222222222.jpg'])
  fs.symlinkSync('releases/20261118T000000Z-ccccccc', path.join(host, 'current'))
  fs.symlinkSync('releases/20261117T000000Z-bbbbbbb', path.join(host, 'previous'))
  for (const name of ['film-720.1111111111.mp4', 'film-poster.2222222222.jpg', 'film-720.3333333333.mp4']) file(name)
  file('gone-720.4444444444.mp4') // no release names it: the only file to remove
  file('fresh-720.5555555555.mp4', { recent: true }) // a release being uploaded right now
  file('notes.txt') // not a media name: never touched
  return { host, media, release }
}
const PRUNE_SCRIPT = fileURLToPath(new URL('../deploy/media-prune.sh', import.meta.url))

test('media-prune is a dry run by default: it lists only files no kept release names, and deletes nothing', (t) => {
  const { host, media } = pruneHost(t)
  const run = stubs(t, { bodies: { ssh: FAKE_SSH }, env: { FAKE_HOST: host } })
  for (const args of [['media-prune'], ['media-prune', '--dry-run']]) {
    const result = run(...args)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /remove: gone-720\.4444444444\.mp4/)
    assert.match(result.out, /keep \(changed in the last 3 h\): fresh-720\.5555555555\.mp4/)
    assert.match(result.out, /keep \(not a media file name, left alone\): notes\.txt/)
    assert.match(result.out, /3 files referenced by 2 release manifests/)
    assert.match(result.out, /dry run: nothing deleted/)
    assert.equal((result.out.match(/remove: /g) || []).length, 1, args.join(' '))
    assert.equal(fs.readdirSync(media).length, 6, 'nothing deleted')
    assert.match(result.calls[0], /^ssh deploy-stub\.invalid bash -s -- \/var\/www\/shapewall\.com$/)
  }
})

test('media-prune --yes deletes exactly the listed files', (t) => {
  const { host, media } = pruneHost(t)
  const run = stubs(t, { bodies: { ssh: FAKE_SSH }, env: { FAKE_HOST: host } })
  const result = run('media-prune', '--yes')
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /deleted 1 files/)
  assert.deepEqual(fs.readdirSync(media).sort(), [
    'film-720.1111111111.mp4',
    'film-720.3333333333.mp4',
    'film-poster.2222222222.jpg',
    'fresh-720.5555555555.mp4',
    'notes.txt',
  ])
})

test('media-prune refuses when a release links media but carries no manifest', (t) => {
  const { host, media, release } = pruneHost(t)
  release('20261118T120000Z-ddddddd', [], { manifest: false })
  const result = spawnSync('bash', [PRUNE_SCRIPT, '--yes', host], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout + result.stderr, /links media\/ but has no \.media-manifest\.json: cannot tell what it uses; nothing pruned/)
  assert.equal(fs.readdirSync(media).length, 6, 'nothing deleted')
})

test('a release carries the manifest it was built with (for media-prune)', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8')
  const copy = script.indexOf('cp "$MANIFEST" dist/.media-manifest.json')
  assert.ok(copy > 0, 'deploy.sh copies the manifest into the release')
  assert.ok(copy < script.indexOf('tar -C dist -cf - .'), 'before the release is uploaded')
})
