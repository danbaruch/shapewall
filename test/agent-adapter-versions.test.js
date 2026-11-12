// The adapter under a connected agent: the session claude-agent-acp 0.106.0
// starts (mode "auto", reported both ways, with the mode's update ahead of the
// answer to a switch) works read-only and for edits as 0.93.0's does; a start
// that fails says why, with the adapter's version and what to try, in the
// chat and in the log; `agent connect` checks the session before it goes
// online and warns about a version it was not tested with; an expired code
// names the command that was run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TESTED_ADAPTERS, acpHandshake, adapterName, adapterStatus, adapterWarning, createAcpBackend } from '../src/agent/backends/acp.js'
import { agentConnect, askedOf } from '../src/remote/agent-connect.js'
import { login } from '../src/remote/login.js'
import { ACP_STUB } from './hosted-chat-helpers.js'
import { tempDir } from './helpers.js'

const CLAUDE = '@agentclientprotocol/claude-agent-acp'
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// A PATH folder whose "claude-agent-acp" is the stub with these arguments.
function stubBin(args = []) {
  const bin = tempDir('adapter-bin')
  const quoted = args.map((arg) => `"${arg}"`).join(' ')
  fs.writeFileSync(path.join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec "${process.execPath}" "${ACP_STUB}" ${quoted} "$@"\n`, {
    mode: 0o755,
  })
  return bin
}
const settingsFor = (args, how) => ({
  configured: true,
  backend: 'acp',
  label: 'Claude Code',
  acp: { argv: [path.join(stubBin(args), 'claude-agent-acp')] },
  vision: false,
  ...how,
})
const ENV = { PATH: process.env.PATH, HOME: os.homedir() }

// One turn with the backend a connected agent gets: { text, events, error, log }.
async function turn(args, prompt, how = { readOnly: true }) {
  const log = []
  const backend = createAcpBackend(settingsFor(args, how), {
    env: ENV,
    root: tempDir('adapter-root'),
    log: (line) => log.push(line),
  })
  const events = []
  let error = null
  try {
    for await (const event of backend.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: new AbortController().signal,
      thread: 'sample/board',
    }))
      events.push(event)
  } catch (thrown) {
    error = thrown
  } finally {
    backend.close()
  }
  return {
    events,
    error,
    log,
    text: events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
  }
}

test('the tested versions are named, and any other is told apart: newer, or just not tested', () => {
  assert.deepEqual(TESTED_ADAPTERS.claude, { name: CLAUDE, versions: ['0.93.0', '0.106.0'] })
  assert.equal(adapterName({ name: CLAUDE, title: 'Claude Agent', version: '0.106.0' }), `${CLAUDE} 0.106.0`)
  assert.equal(adapterName(null), '')
  assert.equal(adapterStatus('claude', { name: CLAUDE, version: '0.93.0' }).state, 'tested')
  assert.equal(adapterStatus('claude', { name: CLAUDE, version: '0.106.0' }).state, 'tested')
  assert.equal(adapterStatus('claude', { name: CLAUDE, version: '0.107.0' }).state, 'newer')
  assert.equal(adapterStatus('claude', { name: CLAUDE, version: '1.0.0' }).state, 'newer')
  assert.equal(adapterStatus('claude', { name: CLAUDE, version: '0.100.2' }).state, 'untested')
  assert.equal(adapterStatus('claude', { name: CLAUDE, version: '0.80.0' }).state, 'untested')
  assert.equal(adapterStatus('claude', { name: 'another-adapter', version: '0.106.0' }).state, 'untested')
  assert.equal(adapterStatus('claude', null).state, 'untested')
  assert.equal(adapterStatus('codex', { name: 'codex-acp', version: '1.0.0' }), null, 'no tested list, nothing to say')
  assert.equal(adapterWarning('claude', { name: CLAUDE, version: '0.106.0' }, 'Claude Code'), null)
  const newer = adapterWarning('claude', { name: CLAUDE, version: '0.120.0' }, 'Claude Code')
  assert.match(newer, /Claude Code runs through @agentclientprotocol\/claude-agent-acp 0\.120\.0, which is newer than the versions/)
  assert.ok(newer.includes(`Shapewall ${VERSION} was tested with (${CLAUDE} 0.93.0 and 0.106.0)`))
  assert.match(newer, /It is used as it is\./)
  assert.ok(newer.includes(`npm install -g ${CLAUDE}@0.106.0`))
  assert.match(adapterWarning('claude', { name: CLAUDE, version: '0.50.0' }, 'Claude Code'), /which is not a version Shapewall/)
  assert.match(adapterWarning('claude', null, 'Claude Code'), /an adapter that does not say its version/)
})

test('0.106.0: a session that starts in "auto" is switched to "default" and answers, read only and for edits', async () => {
  // The bug of 0.6.0: the mode's update came before the answer to the switch, the "mode" option still said
  // "auto", and the agent was stopped as unsafe. The first question then failed with "did not start."
  for (const how of [{ readOnly: true }, { remoteEdit: { commands: [], allowPaths: [] } }]) {
    const said = await turn(['--v106', `--agent-info=${CLAUDE}@0.106.0`], 'mode', how)
    assert.equal(said.error, null, said.error?.message)
    assert.equal(said.text, 'default')
    assert.deepEqual(said.log, ['acp: Claude Code switched from mode "auto" to "default" (read only)'])
  }
  // The session options still leave the settings files out and keep the tools to reading ones.
  const sent = JSON.parse((await turn(['--v106'], 'newparams')).text)
  assert.deepEqual(sent._meta.claudeCode.options.settingSources, [])
  assert.deepEqual(sent._meta.claudeCode.options.tools, ['Read', 'Grep', 'Glob'])
  assert.equal(sent._meta.claudeCode.options.strictMcpConfig, true)
  // Started in a mode that asks: left alone. Started in "acceptEdits": switched too.
  assert.equal((await turn(['--v106', '--start-mode=default'], 'mode')).log.length, 0)
  assert.equal((await turn(['--v106', '--start-mode=acceptEdits'], 'mode')).text, 'default')
  // The older report (0.93.0: modes only, started in "default") is unchanged.
  const old = await turn(['--ro-modes', `--agent-info=${CLAUDE}@0.93.0`], 'mode')
  assert.equal(old.error, null)
  assert.deepEqual(old.log, [])
})

test('nothing is weakened: a session that moves itself to a mode that acts without asking is stopped, and the chat hears why', async () => {
  for (const how of [{ readOnly: true }, { remoteEdit: { commands: [], allowPaths: [] } }]) {
    // The mode's own update alone (the "mode" option is never updated): the mode it names is checked itself.
    const moved = await turn(['--v106', `--agent-info=${CLAUDE}@0.106.0`], 'selfswitch acceptEdits', how)
    assert.equal(moved.error?.code, 'agent_unsafe_mode')
    assert.match(moved.error.message, /moved to the mode "acceptEdits", which acts without asking/)
    assert.ok(moved.error.message.includes(`(through ${CLAUDE} 0.106.0)`))
    assert.ok(moved.log.some((line) => /moved to the mode "acceptEdits".*it was stopped/.test(line)))
    assert.ok(moved.events.filter((event) => event.type === 'text').length < 40, 'stopped before it finished talking')
    const auto = await turn(['--v106'], 'selfswitch auto', how)
    assert.equal(auto.error?.code, 'agent_unsafe_mode')
  }
  // To a mode that asks: it goes on.
  const fine = await turn(['--v106'], 'selfswitch plan')
  assert.equal(fine.error, null)
  assert.match(fine.text, /still here 39/)
  // Not a connected agent (the local board): its modes are its own business.
  const local = await turn(['--v106'], 'selfswitch acceptEdits', {})
  assert.equal(local.error, null)
})

test('a start that fails says why: the error, the adapter and its version, its last output, and what to try', async () => {
  const failed = await turn(['--ro-modes', `--agent-info=${CLAUDE}@0.106.0`, '--new-fails=the settings are broken'], 'stream')
  assert.equal(failed.error?.code, 'agent_start')
  const message = failed.error.message
  assert.match(message, /Claude Code did not start an ACP session \(.*the settings are broken\)/)
  assert.ok(message.includes(`(through ${CLAUDE} 0.106.0)`))
  assert.match(message, /Its last output: stub stderr: the settings are broken/)
  assert.match(message, /run "shapewall doctor"/)
  assert.doesNotMatch(message, /did not start\.$/)
  assert.ok(message.length <= 500, 'fits what a hosted board shows')
  // The same in the machine's log, with more of the output.
  assert.ok(failed.log.includes(`acp: ${message}`))
  assert.ok(failed.log.some((line) => line === 'acp: Claude Code last output: stub stderr: the settings are broken'))

  // An adapter that is newer than the tested ones: the hint is a tested version.
  const newer = await turn(['--ro-modes', `--agent-info=${CLAUDE}@0.200.0`, '--new-fails=no such option'], 'stream')
  assert.ok(newer.error.message.includes(`(through ${CLAUDE} 0.200.0)`))
  assert.ok(newer.error.message.includes(`not one Shapewall ${VERSION} was tested with (0.93.0, 0.106.0)`))
  assert.ok(newer.error.message.includes(`npm install -g ${CLAUDE}@0.106.0`))

  // It went away while it started: the exit code and what it wrote.
  const gone = await turn(['--ro-modes', `--agent-info=${CLAUDE}@0.106.0`, '--new-exits'], 'stream')
  assert.equal(gone.error?.code, 'agent_exited')
  assert.match(gone.error.message, /Claude Code stopped while it started \(code 7\)/)
  assert.match(gone.error.message, /Its last output: stub stderr: cannot go on/)
  assert.ok(gone.error.message.includes(`${CLAUDE} 0.106.0`))
  assert.ok(gone.log.some((line) => line.startsWith('acp: Claude Code stopped while it started (code 7)')))

  // No mode it can be switched to: said with the adapter.
  const unsafe = await turn([`--agent-info=${CLAUDE}@0.106.0`], 'stream')
  assert.equal(unsafe.error?.code, 'agent_unsafe_mode')
  assert.match(unsafe.error.message, /reports no session mode/)
  assert.ok(unsafe.error.message.includes(`Its adapter: ${CLAUDE} 0.106.0.`))
  assert.ok(unsafe.log.some((line) => /reports no session mode/.test(line)))

  // The home folder is not spelled out, and nothing that looks like a key is passed on.
  const home = await turn(
    ['--ro-modes', `--new-fails=cannot read ${os.homedir()}/.claude/settings.json with sk-ant-REDACTME1234567890abcd`],
    'stream',
  )
  assert.match(home.error.message, /~\/\.claude\/settings\.json/)
  assert.ok(!home.error.message.includes(os.homedir()))
})

test('the session check `agent connect` runs: the session a connected agent gets, opened and closed without a prompt', async () => {
  const root = tempDir('adapter-check')
  const ok = await acpHandshake(settingsFor(['--v106', `--agent-info=${CLAUDE}@0.106.0`], { readOnly: true }), { env: ENV, root })
  assert.equal(ok.ok, true)
  assert.equal(ok.mode, 'default', 'switched, as a turn would be')
  assert.deepEqual([ok.agentInfo.name, ok.agentInfo.version], [CLAUDE, '0.106.0'])
  const edits = await acpHandshake(settingsFor(['--v106'], { remoteEdit: { commands: [], allowPaths: [] } }), { env: ENV, root })
  assert.equal(edits.ok, true)
  const bad = await acpHandshake(
    settingsFor(['--ro-modes', `--agent-info=${CLAUDE}@0.106.0`, '--new-fails=broken here'], { readOnly: true }),
    {
      env: ENV,
      root,
    },
  )
  assert.equal(bad.ok, false)
  assert.match(bad.message, /did not start an ACP session \(.*broken here\)/)
  assert.equal(bad.agentInfo.version, '0.106.0')
  assert.match(bad.stderr, /stub stderr: broken here/)
  // Fail closed, as before: no mode reported is not a session a connected agent may have.
  const silent = await acpHandshake(settingsFor([], { readOnly: true }), { env: ENV, root })
  assert.equal(silent.ok, false)
  assert.equal(silent.code, 'agent_unsafe_mode')
})

// `agent connect` with a token of its own up to the point where it would go online.
async function connectUntilLink(args, flags = {}) {
  const env = {
    PATH: `${stubBin(args)}${path.delimiter}${process.env.PATH}`,
    HOME: tempDir('adapter-home'),
    XDG_CONFIG_HOME: tempDir('adapter-xdg'),
    XDG_STATE_HOME: tempDir('adapter-state'),
    SHAPEWALL_TOKEN: `swp_${'a'.repeat(43)}`,
  }
  const out = []
  const err = []
  // The link is refused at once (no such server): what matters is what was said before it.
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), { status: 401 })
  let error = null
  try {
    await agentConnect(
      { remote: 'https://wall.example.com', agent: 'claude', ...flags },
      (line) => out.push(line),
      (line) => err.push(line),
      {
        env,
        cwd: tempDir('adapter-cwd'),
        fetchImpl,
      },
    )
  } catch (thrown) {
    error = thrown
  }
  return { out, err, error }
}

test('agent connect checks at startup that a session opens, and says which adapter answers', async () => {
  const tested = await connectUntilLink(['--v106', `--agent-info=${CLAUDE}@0.106.0`])
  assert.ok(
    tested.err.includes(`Claude Code answers through ${CLAUDE} 0.106.0, a version this release was tested with.`),
    tested.err.join('\n'),
  )
  assert.ok(!tested.err.some((line) => /^Warning:/.test(line)))
  assert.match(tested.error.message, /token was revoked or has expired/, 'it went on to the link')

  // Newer than the tested ones: a plain warning, and it goes on.
  const newer = await connectUntilLink(['--v106', `--agent-info=${CLAUDE}@0.130.1`])
  const warning = newer.err.find((line) => /^Warning:/.test(line))
  assert.match(warning, /0\.130\.1, which is newer than the versions Shapewall .* was tested with/)
  assert.ok(warning.includes(`npm install -g ${CLAUDE}@0.106.0`))
  assert.match(newer.error.message, /token was revoked or has expired/, 'warned, not refused')

  // A session that cannot be opened: not connected, with the cause.
  const broken = await connectUntilLink(['--ro-modes', `--agent-info=${CLAUDE}@0.106.0`, '--new-fails=permissions file is not JSON'])
  assert.match(broken.error.message, /^Claude Code could not open a read-only session on this machine, so it is not connected\./)
  assert.match(broken.error.message, /permissions file is not JSON/)
  assert.ok(broken.error.message.includes(`${CLAUDE} 0.106.0`))
  assert.ok(broken.err.some((line) => line === 'Claude Code last output: stub stderr: permissions file is not JSON'))
  assert.doesNotMatch(broken.error.message, /token was revoked/, 'it never went online')
})

test('what the machine asked for goes with the code, and an expired code names the command that was run', async () => {
  assert.deepEqual(askedOf({ approvals: 'none', auto: [], base: null }), { approvals: 'none', auto: false, base: null })
  assert.deepEqual(askedOf({ approvals: 'owner', auto: ['edits'], base: 'main' }, 'claude'), {
    approvals: 'owner',
    auto: true,
    base: 'main',
  })
  assert.deepEqual(askedOf({ approvals: 'admins', auto: ['commands'], base: null }, 'claude'), {
    approvals: 'admins',
    auto: false,
    base: null,
  })
  // Without edits, nothing else is claimed.
  assert.deepEqual(askedOf({ approvals: 'none', auto: ['edits'], base: 'main' }), { approvals: 'none', auto: false, base: null })

  const started = []
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/v1/device/start')) {
      started.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ deviceCode: 'd'.repeat(43), userCode: 'BCDF-GHJK', interval: 1, expiresIn: 600 }), {
        status: 201,
      })
    }
    return new Response(JSON.stringify({ error: { code: 'login_expired', message: 'This login expired. Run shapewall login again.' } }), {
      status: 410,
    })
  }
  const env = {
    PATH: `${stubBin(['--v106'])}${path.delimiter}${process.env.PATH}`,
    HOME: tempDir('adapter-home'),
    XDG_CONFIG_HOME: tempDir('adapter-xdg'),
    XDG_STATE_HOME: tempDir('adapter-state'),
    SHAPEWALL_NO_BROWSER: '1',
  }
  await assert.rejects(
    agentConnect(
      { remote: 'https://wall.example.com', agent: 'claude', approvals: 'owner', auto: 'edits', base: 'main' },
      () => {},
      () => {},
      { env, cwd: tempDir('adapter-cwd'), fetchImpl, sleep: async () => {} },
    ),
    (error) => {
      assert.equal(error.message, 'The code expired before anyone approved it. Run shapewall agent connect again for a new one.')
      return true
    },
  )
  assert.deepEqual(started[0].agent, { kind: 'claude', name: 'Claude Code', asks: { approvals: 'owner', auto: true, base: 'main' } })
  // `shapewall login` still names itself.
  await assert.rejects(
    login({ remote: 'https://wall.example.com' }, () => {}, { env, fetchImpl, sleep: async () => {}, open: () => false }),
    /Run shapewall login again for a new one\./,
  )
})
