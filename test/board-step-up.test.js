// Board approvals ask for a passkey only when the hosted server says so
// (finding 41): passkey required, optional, or off (tailnet sign-in).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendWithStepUp } from '../client/src/board/stepUp.js'

const reauth = () => Object.assign(new Error('Confirm with your passkey.'), { code: 'reauth_required' })

// A server whose cards policy wants a fresh passkey `required` times.
function server({ required = 0 } = {}) {
  const sent = []
  let left = required
  let confirmed = 0
  return {
    sent,
    confirmed: () => confirmed,
    send: (body) => async () => {
      sent.push(body)
      if (left > 0 && confirmed === 0) throw reauth()
      return { ok: true }
    },
    confirm: async () => {
      confirmed += 1
      left -= 1
    },
  }
}

test('passkeys off or not required: the approval goes once, no passkey is asked for', async () => {
  const host = server()
  const result = await sendWithStepUp(host.send({ dispatchHash: 'h1', approve: true }), host.confirm)
  assert.deepEqual(result, { ok: true })
  assert.equal(host.confirmed(), 0)
  assert.deepEqual(host.sent, [{ dispatchHash: 'h1', approve: true }])
})

test('passkey required: asked for after the server says so, then the same hash goes again', async () => {
  const host = server({ required: 1 })
  await sendWithStepUp(host.send({ dispatchHash: 'h1', approve: true }), host.confirm)
  assert.equal(host.confirmed(), 1)
  assert.deepEqual(host.sent, [
    { dispatchHash: 'h1', approve: true },
    { dispatchHash: 'h1', approve: true },
  ])
})

test('any other failure is not a passkey question', async () => {
  const changed = Object.assign(new Error('changed'), { code: 'comment_changed' })
  let confirmed = 0
  await assert.rejects(
    sendWithStepUp(
      async () => {
        throw changed
      },
      async () => {
        confirmed += 1
      },
    ),
    changed,
  )
  assert.equal(confirmed, 0)
})

test('a passkey prompt that is cancelled sends nothing more', async () => {
  const host = server({ required: 1 })
  const cancelled = new Error('cancelled')
  await assert.rejects(
    sendWithStepUp(host.send({ dispatchHash: 'h1' }), async () => {
      throw cancelled
    }),
    cancelled,
  )
  assert.equal(host.sent.length, 1)
})
