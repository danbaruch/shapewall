import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { cleanDemoAvatar, demoAvatarUrl, DEMO_AVATAR_BYTES } from '../client/src/demo/avatar.js'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { seedState } from '../client/src/demo/fixtures.js'

const fixture = () => {
  const image = new PNG({ width: 256, height: 256 })
  for (let i = 0; i < image.data.length; i += 4) image.data.set([72, 121, 200, 255], i)
  return PNG.sync.write(image)
}
function pngChunk(type, data) {
  const part = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of part) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  part.copy(out, 4)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
  return out
}

test('demo avatars validate and reencode pixels while discarding metadata', async () => {
  const input = fixture()
  const tagged = Buffer.concat([input.subarray(0, 33), pngChunk('tEXt', Buffer.from('private\0fictional metadata')), input.subarray(33)])
  const clean = Buffer.from(await cleanDemoAvatar(tagged.toString('base64')), 'base64')
  assert.deepEqual(PNG.sync.read(clean).data, PNG.sync.read(input).data)
  assert.equal(clean.includes(Buffer.from('fictional metadata')), false)
  assert.ok(clean.length <= DEMO_AVATAR_BYTES)
})

test('demo avatars reject malformed, oversized, animated, corrupt and inflated input', async () => {
  const good = fixture()
  const corrupt = Buffer.from(good)
  corrupt[45] ^= 1
  const wrongSize = PNG.sync.write(new PNG({ width: 1, height: 1 }))
  const animated = Buffer.concat([good.subarray(0, 33), pngChunk('acTL', Buffer.alloc(8)), good.subarray(33)])
  const bomb = Buffer.concat([
    good.subarray(0, 33),
    pngChunk('IDAT', deflateSync(Buffer.alloc((256 * 4 + 1) * 257))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  for (const value of [
    null,
    '',
    'https://example.com/avatar.png',
    `${good.toString('base64')}\n`,
    Buffer.alloc(DEMO_AVATAR_BYTES + 1).toString('base64'),
    ...[corrupt, wrongSize, animated, bomb, Buffer.concat([good, Buffer.from('extra')])].map((item) => item.toString('base64')),
  ]) {
    await assert.rejects(cleanDemoAvatar(value), /256 by 256 PNG/)
  }
})

test('demo profile photos belong to the selected user and stay in browser state', async () => {
  const state = seedState()
  let saves = 0
  const backend = createDemoBackend({ state, save: () => saves++, loadJson: () => assert.fail('avatar operations never fetch a server') })
  const call = (method, path, body) => backend.handle({ method, path, body })
  const initial = await call('GET', '/auth/me')
  const owner = initial.json.user.id
  assert.equal(initial.json.user.avatarUrl, null)
  const uploaded = await call('PUT', '/auth/me/avatar', { png: fixture().toString('base64') })
  assert.equal(uploaded.status, 200)
  assert.match(uploaded.json.avatarUrl, /^data:image\/png;base64,/)
  assert.equal((await call('GET', '/auth/me')).json.user.avatarUrl, uploaded.json.avatarUrl)
  assert.equal((await call('GET', '/api/info')).json.user.avatarUrl, uploaded.json.avatarUrl)
  assert.ok(saves > 0)
  for (const body of [
    { png: 'bad' },
    { png: fixture().toString('base64'), userId: 'someone-else' },
    { url: 'https://example.com/photo.png' },
  ]) {
    assert.equal((await call('PUT', '/auth/me/avatar', body)).status, 400)
    assert.equal(demoAvatarUrl(state, owner), uploaded.json.avatarUrl)
  }
  backend.setViewAs('admin')
  assert.equal((await call('GET', '/auth/me')).json.user.avatarUrl, null)
  await call('DELETE', '/auth/me/avatar')
  assert.equal(demoAvatarUrl(state, owner), uploaded.json.avatarUrl)
  backend.setViewAs('owner')
  assert.deepEqual((await call('DELETE', '/auth/me/avatar')).json, { avatarUrl: null })
  assert.equal((await call('GET', '/auth/me')).json.user.avatarUrl, null)
  for (const role of ['guest', 'owner']) {
    backend.setViewAs(role)
    state.signedOut = role === 'owner'
    assert.equal((await call('PUT', '/auth/me/avatar', { png: fixture().toString('base64') })).status, 401)
    assert.equal((await call('DELETE', '/auth/me/avatar')).status, 401)
  }
  assert.deepEqual(seedState().avatars, {})
  assert.equal(demoAvatarUrl({ avatars: { [owner]: 'https://example.com/photo.png' } }, owner), null)
})
