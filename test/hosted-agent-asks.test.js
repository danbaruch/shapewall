// What a machine asks for when it connects an agent (`--approvals`, `--auto`,
// `--base`) reaches the person who approves it: the device login carries it
// as the terminal's own report, cleaned, and the approval page says it in words.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { agentAsks, agentAsksDone } from '../client/src/console/lib/agent-asks.js'
import { cleanAgentAsks, cleanAgentMeta } from '../src/hosted/device.js'
import { signUp, startHostedServer } from './hosted-helpers.js'

test('the report is cleaned: known values only, nothing claimed without edits, and absent when the terminal did not say', () => {
  assert.equal(cleanAgentAsks(undefined), null)
  assert.equal(cleanAgentAsks('owner'), null)
  assert.equal(cleanAgentAsks([]), null)
  assert.deepEqual(cleanAgentAsks({}), { approvals: 'none', auto: false, base: null })
  assert.deepEqual(cleanAgentAsks({ approvals: 'owner', auto: true, base: 'main' }), { approvals: 'owner', auto: true, base: 'main' })
  assert.deepEqual(cleanAgentAsks({ approvals: 'admins', auto: 'yes', base: 'release/1.x' }), {
    approvals: 'admins',
    auto: false,
    base: 'release/1.x',
  })
  // An unknown rule reads as the narrowest, and then nothing else is said.
  assert.deepEqual(cleanAgentAsks({ approvals: 'everyone', auto: true, base: 'main' }), { approvals: 'none', auto: false, base: null })
  // A branch name that is not one (markup, spaces, too long) is dropped.
  for (const base of ['<b>main</b>', 'two words', '-x', 'a'.repeat(101), 7])
    assert.equal(cleanAgentAsks({ approvals: 'owner', base }).base, null, String(base))
  assert.deepEqual(cleanAgentMeta({ kind: 'claude', name: 'Builder' }), { kind: 'claude', name: 'Builder' })
  assert.deepEqual(cleanAgentMeta({ kind: 'claude', name: 'Builder', asks: { approvals: 'owner' } }), {
    kind: 'claude',
    name: 'Builder',
    asks: { approvals: 'owner', auto: false, base: null },
  })
})

test('the approval page says what was asked: read only, edits and who answers, auto, the base branch, never commands', () => {
  const read = agentAsks({ approvals: 'none', auto: false, base: null })
  assert.equal(read.mode, 'read')
  assert.ok(read.lines.some((line) => /Does not change files and runs no commands/.test(line)))
  assert.ok(!read.lines.some((line) => /Edits files/.test(line)))

  const owner = agentAsks({ approvals: 'owner', auto: false, base: null })
  assert.equal(owner.mode, 'edits')
  const text = owner.lines.join('\n')
  assert.match(
    text,
    /Edits files when a fix is asked on the board\. Each edit is shown on the board and waits for you, the person who connects it\./,
  )
  assert.match(text, /on a new branch, never in that machine's checkout/)
  assert.match(text, /A fix starts from the commit that machine's checkout is on\./)
  assert.match(text, /Never runs a command for the board/)
  assert.doesNotMatch(text, /does not change files/i)
  assert.doesNotMatch(text, /without asking/)

  const admins = agentAsks({ approvals: 'admins', auto: true, base: 'main' }).lines.join('\n')
  assert.match(admins, /waits for whoever this server lets answer \(admins by default\)/)
  assert.match(admins, /Asked to allow edits without asking: that stays off until an admin switches it on/)
  assert.match(admins, /not pushed until a person has looked at its whole diff/)
  assert.match(admins, /A fix starts from the branch main\./)
  assert.match(admins, /Never runs a command for the board/)
  assert.match(agentAsks({ approvals: 'owner', auto: true, base: null }).lines.join('\n'), /until you switch it on/)

  // An older shapewall says nothing: the page does not promise "no edits" for it.
  const unknown = agentAsks(null)
  assert.equal(unknown.mode, 'unknown')
  assert.match(unknown.lines.join('\n'), /did not say whether it also takes edits/)
  assert.doesNotMatch(unknown.lines.join('\n'), /does not change files/i)

  assert.match(agentAsksDone({ approvals: 'none' }), /does not change files or run commands/)
  assert.match(
    agentAsksDone({ approvals: 'owner' }),
    /makes fixes asked on the board on a branch of their own, each edit allowed by you first; it runs no commands/,
  )
  assert.match(agentAsksDone({ approvals: 'admins' }), /allowed by whoever this server lets answer first/)
  assert.match(agentAsksDone(undefined), /its terminal says whether it also takes edits/)
})

let hosted
let ada
before(async () => {
  hosted = await startHostedServer('agent-asks')
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
})
after(async () => {
  await hosted?.close()
})

test('the device login carries the report to the approver, and to nobody as anything more', async () => {
  const start = async (agent) =>
    (
      await fetch(`${hosted.origin}/api/v1/device/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'studio', purpose: 'agent', agent }),
      })
    ).json()
  const lookup = async (code) => (await ada.browser.post('/api/device/lookup', { code })).json.login
  const edits = await start({
    kind: 'claude',
    name: 'Builder',
    asks: { approvals: 'owner', auto: true, base: 'main', commands: ['rm -rf /'] },
  })
  assert.deepEqual((await lookup(edits.userCode)).agent, {
    kind: 'claude',
    name: 'Builder',
    asks: { approvals: 'owner', auto: true, base: 'main' },
  })
  const old = await start({ kind: 'claude', name: 'Builder' })
  assert.deepEqual((await lookup(old.userCode)).agent, { kind: 'claude', name: 'Builder' })
  // A plain login carries none of it.
  const plain = await (
    await fetch(`${hosted.origin}/api/v1/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'studio', agent: { kind: 'claude', asks: { approvals: 'owner' } } }),
    })
  ).json()
  assert.equal((await lookup(plain.userCode)).agent, undefined)
})
