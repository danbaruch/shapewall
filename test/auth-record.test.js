import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { authCommand, recordCaptureAuth } from '../src/auth/record.js'
import { sampleConfig, tempDir } from './helpers.js'

const STATE = {
  cookies: [
    {
      name: 'fixture-session',
      value: 'fictional-secret',
      domain: 'localhost',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ],
  origins: [],
}
function fixture() {
  const config = sampleConfig('auth-record')
  fs.writeFileSync(config.file, JSON.stringify({ fixture: true }))
  const browser = new EventEmitter()
  const tracked = { launch: 0, context: 0, contextClosed: 0, browserClosed: 0 }
  browser.newContext = async (options) => {
    assert.equal(options, undefined, 'fresh context receives no prior storage state')
    tracked.context++
    return {
      newPage: async () => ({ goto: async () => {} }),
      storageState: async () => STATE,
      close: async () => {
        tracked.contextClosed++
      },
    }
  }
  browser.close = async () => {
    tracked.browserClosed++
    browser.emit('disconnected')
  }
  const launch = async (options) => {
    tracked.launch++
    tracked.options = options
    return browser
  }
  return { config, browser, tracked, launch, headless: true, finish: async () => {} }
}
const statePath = (config) => path.join(config.dir, '.shapewall-auth', 'sample.auth.json')
const privateMode = (file, expected) => {
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, expected)
}

test('manual recording saves private ignored state, respects browser config and leaves config unchanged', async () => {
  const f = fixture()
  f.config.browser = { channel: 'fixture-channel', executablePath: null }
  f.config.auth = { storageState: '/must-not-read-or-overwrite', loginScript: '/must-not-execute' }
  const before = fs.readFileSync(f.config.file, 'utf8')
  const lines = []
  const code = await authCommand(f.config, ['record'], {}, (line) => lines.push(line), { ...f, env: {} })
  assert.equal(code, 0)
  assert.equal(f.tracked.options.channel, 'fixture-channel')
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath(f.config), 'utf8')), STATE)
  privateMode(path.dirname(statePath(f.config)), 0o700)
  privateMode(statePath(f.config), 0o600)
  assert.equal(fs.readFileSync(path.join(path.dirname(statePath(f.config)), '.gitignore'), 'utf8'), '*\n')
  assert.equal(fs.existsSync(path.join(path.dirname(statePath(f.config)), '.record.lock')), false)
  assert.equal(fs.readFileSync(f.config.file, 'utf8'), before)
  assert.equal(f.tracked.contextClosed, 1)
  assert.equal(f.tracked.browserClosed, 1)
  assert.match(lines.join('\n'), /loginScript still takes priority/)
  assert.match(lines.join('\n'), /Next capture:.*capture.*--board sample --env default/)
  assert.doesNotMatch(lines.join('\n'), /fictional-secret|localhost|127\.0\.0\.1|must-not/)
})

test('existing state needs explicit overwrite; cancel/timeout preserve prior bytes and release lock', async () => {
  const f = fixture()
  await recordCaptureAuth(f)
  const before = fs.readFileSync(statePath(f.config))
  await assert.rejects(recordCaptureAuth(f), { code: 'auth_exists' })
  assert.equal(f.tracked.launch, 1)
  const controller = new AbortController()
  await assert.rejects(
    recordCaptureAuth({
      ...f,
      overwrite: true,
      signal: controller.signal,
      finish: async () => {
        controller.abort()
        await new Promise(() => {})
      },
    }),
    { code: 'auth_cancelled' },
  )
  await assert.rejects(recordCaptureAuth({ ...f, overwrite: true, timeoutMs: 20, finish: async () => new Promise(() => {}) }), {
    code: 'auth_timeout',
  })
  assert.deepEqual(fs.readFileSync(statePath(f.config)), before)
  assert.equal(fs.existsSync(path.join(path.dirname(statePath(f.config)), '.record.lock')), false)
  await recordCaptureAuth({ ...f, overwrite: true })
  privateMode(statePath(f.config), 0o600)
})

test('terminal Enter explicitly saves; typed cancel and EOF discard, no password text enters output', async () => {
  const f = fixture()
  const lines = []
  const input = new PassThrough()
  input.isTTY = true
  const recording = recordCaptureAuth({
    ...f,
    finish: undefined,
    input,
    out: (line) => {
      lines.push(line)
      if (line.startsWith('Sign in manually')) input.write('not-a-password-command\n\n')
    },
  })
  await recording
  assert.doesNotMatch(lines.join('\n'), /not-a-password-command|fictional-secret/)
  const second = fixture()
  const cancelInput = new PassThrough()
  cancelInput.isTTY = true
  await assert.rejects(recordCaptureAuth({ ...second, finish: undefined, input: cancelInput, out: () => cancelInput.write('cancel\n') }), {
    code: 'auth_cancelled',
  })
  assert.equal(fs.existsSync(statePath(second.config)), false)
  const third = fixture()
  const eof = new PassThrough()
  eof.isTTY = true
  await assert.rejects(recordCaptureAuth({ ...third, finish: undefined, input: eof, out: () => eof.end() }), { code: 'auth_cancelled' })
  assert.equal(fs.existsSync(statePath(third.config)), false)
})

test('only one recording owns the private directory, even for explicit overwrite', async () => {
  const f = fixture()
  let started
  let release
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const wait = new Promise((resolve) => {
    release = resolve
  })
  const first = recordCaptureAuth({
    ...f,
    finish: async () => {
      started()
      await wait
    },
  })
  await ready
  await assert.rejects(recordCaptureAuth({ ...f, overwrite: true }), { code: 'auth_locked' })
  release()
  await first
})

test('terminal errors are redacted and release the browser and recording lock', async () => {
  const f = fixture()
  const input = new PassThrough()
  input.isTTY = true
  const lines = []
  await assert.rejects(
    recordCaptureAuth({
      ...f,
      finish: undefined,
      input,
      out: (line) => {
        lines.push(line)
        input.destroy(new Error('fictional-secret-terminal-error'))
      },
    }),
    (error) => error.code === 'auth_terminal' && !error.message.includes('fictional-secret'),
  )
  assert.equal(f.tracked.browserClosed, 1)
  assert.equal(fs.existsSync(statePath(f.config)), false)
  assert.equal(fs.existsSync(path.join(f.config.dir, '.shapewall-auth', '.record.lock')), false)
  assert.doesNotMatch(lines.join('\n'), /fictional-secret/)
})

test('noninteractive input, unsafe URL and unsupported action/timeout fail before launch', async () => {
  const f = fixture()
  await assert.rejects(recordCaptureAuth({ ...f, finish: undefined, input: {} }), { code: 'auth_terminal' })
  for (const url of ['file:///private', 'https://user:fictional-secret@example.test', 'not a url'])
    await assert.rejects(recordCaptureAuth({ ...f, url }), { code: 'auth_url' })
  await assert.rejects(
    authCommand(f.config, ['unknown'], {}, () => {}, f),
    { code: 'auth_command' },
  )
  for (const timeout of ['x', '0', '1801', '1.5'])
    await assert.rejects(
      authCommand(f.config, ['record'], { timeout }, () => {}, f),
      { code: 'auth_timeout' },
    )
  assert.equal(f.tracked.launch, 0)
})

test('browser errors redact URL/query details and closing browser discards state', async () => {
  const f = fixture()
  const lines = []
  await assert.rejects(
    recordCaptureAuth({
      ...f,
      url: 'https://fixture.invalid/login?key=private-query',
      out: (line) => lines.push(line),
      launch: async () => {
        throw new Error('browserType.launch https://fixture.invalid/login?key=private-query cookie=private-cookie')
      },
    }),
    (error) => error.code === 'auth_record_failed' && !/private-query|private-cookie|https:/.test(error.message),
  )
  assert.equal(fs.existsSync(statePath(f.config)), false)
  await assert.rejects(
    recordCaptureAuth({
      ...f,
      finish: async () => {
        f.browser.emit('disconnected')
        await new Promise(() => {})
      },
    }),
    { code: 'auth_cancelled' },
  )
  assert.equal(fs.existsSync(statePath(f.config)), false)
  assert.doesNotMatch(lines.join('\n'), /private-query|private-cookie|https:/)
})

test(
  'symlink/hardlink or broadly readable state destinations are refused before browser launch',
  { skip: process.platform === 'win32' },
  async () => {
    const linked = fixture()
    const outside = tempDir('auth-outside')
    fs.symlinkSync(outside, path.join(linked.config.dir, '.shapewall-auth'))
    await assert.rejects(recordCaptureAuth(linked), { code: 'auth_private_directory' })
    assert.equal(linked.tracked.launch, 0)
    for (const kind of ['symlink', 'hardlink', 'permissions']) {
      const f = fixture()
      await recordCaptureAuth(f)
      const target = statePath(f.config)
      if (kind === 'permissions') fs.chmodSync(target, 0o644)
      else {
        const moved = path.join(outside, `${kind}.json`)
        fs.renameSync(target, moved)
        if (kind === 'symlink') fs.symlinkSync(moved, target)
        else fs.linkSync(moved, target)
      }
      await assert.rejects(recordCaptureAuth({ ...f, overwrite: true }), { code: 'auth_unsafe_file' })
      assert.equal(f.tracked.launch, 1)
    }
  },
)

test('Git-tracked state or tampered ignore rules cannot receive credentials', () => {
  const f = fixture()
  assert.equal(spawnSync('git', ['init', '--quiet', f.config.dir]).status, 0)
  const directory = path.join(f.config.dir, '.shapewall-auth')
  fs.mkdirSync(directory, { mode: 0o700 })
  fs.writeFileSync(path.join(directory, '.gitignore'), '*\n', { mode: 0o600 })
  fs.writeFileSync(statePath(f.config), 'fictional tracked placeholder', { mode: 0o600 })
  assert.equal(spawnSync('git', ['-C', f.config.dir, 'add', '-f', '.shapewall-auth/sample.auth.json']).status, 0)
  return assert.rejects(recordCaptureAuth({ ...f, overwrite: true }), { code: 'auth_tracked' })
})

test('concurrent changes and oversized state fail without replacing prior credentials', async () => {
  const f = fixture()
  await recordCaptureAuth(f)
  const original = fs.readFileSync(statePath(f.config))
  await assert.rejects(
    recordCaptureAuth({
      ...f,
      overwrite: true,
      finish: async () => {
        fs.writeFileSync(statePath(f.config), 'concurrent-owner-write')
      },
    }),
    { code: 'auth_destination_changed' },
  )
  assert.equal(fs.readFileSync(statePath(f.config), 'utf8'), 'concurrent-owner-write')
  fs.writeFileSync(statePath(f.config), original)
  const large = fixture()
  large.browser.newContext = async () => ({
    newPage: async () => ({ goto: async () => {} }),
    storageState: async () => ({ cookies: [], origins: [{ origin: 'fixture', value: 'x'.repeat(11 * 1024 * 1024) }] }),
    close: async () => {},
  })
  await assert.rejects(recordCaptureAuth(large), { code: 'auth_state_large' })
  assert.equal(fs.existsSync(statePath(large.config)), false)
})

test('recording cannot overlap capture output or accept tampered ignore rules', async () => {
  const f = fixture()
  f.config.outputDir = f.config.dir
  await assert.rejects(recordCaptureAuth(f), { code: 'auth_output_overlap' })
  assert.equal(f.tracked.launch, 0)
  const ignored = fixture()
  await recordCaptureAuth(ignored)
  fs.writeFileSync(path.join(ignored.config.dir, '.shapewall-auth', '.gitignore'), '*\n!*.auth.json\n')
  await assert.rejects(recordCaptureAuth({ ...ignored, overwrite: true }), { code: 'auth_git_ignore' })
  assert.equal(ignored.tracked.launch, 1)
  if (process.platform !== 'win32') {
    const alias = fixture()
    await recordCaptureAuth(alias)
    fs.symlinkSync(path.join(alias.config.dir, '.shapewall-auth'), alias.config.outputDir)
    await assert.rejects(recordCaptureAuth({ ...alias, overwrite: true }), { code: 'auth_output_overlap' })
    assert.equal(alias.tracked.launch, 1)
  }
})

test('pre-cancelled recording never launches a browser', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(recordCaptureAuth({ ...f, signal: controller.signal }), { code: 'auth_cancelled' })
  assert.equal(f.tracked.launch, 0)
  assert.equal(fs.existsSync(path.join(f.config.dir, '.shapewall-auth', '.record.lock')), false)
})

test('Git checks skip relative PATH executables in the recording project', { skip: process.platform === 'win32' }, async () => {
  const f = fixture()
  assert.equal(spawnSync('git', ['init', '--quiet', f.config.dir]).status, 0)
  const bin = path.join(f.config.dir, 'relative-bin')
  fs.mkdirSync(bin)
  const marker = path.join(bin, 'executed')
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf executed > '${marker}'\nexit 77\n`, { mode: 0o755 })
  const before = process.env.PATH
  try {
    process.env.PATH = `${path.relative(process.cwd(), bin)}${path.delimiter}${before}`
    await recordCaptureAuth(f)
    assert.equal(fs.existsSync(marker), false)
  } finally {
    process.env.PATH = before
  }
})
