import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { cleanAvatar } from '../src/accounts/avatar.js'
import { createProject, signUp, startHostedServer } from './hosted-helpers.js'

const png = () => PNG.sync.write({ width: 256, height: 256, data: Buffer.alloc(256 * 256 * 4, 150) }, { colorType: 6 })
function chunk(type, data) {
  const name = Buffer.from(type)
  const bytes = Buffer.concat([name, data])
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, bytes, checksum])
}
function crafted({ interlace = 0, idat = deflateSync(Buffer.alloc((256 * 4 + 1) * 256)) } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256, 0)
  header.writeUInt32BE(256, 4)
  header[8] = 8
  header[9] = 6
  header[12] = interlace
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}
test('avatars are decoded and reencoded as canonical RGBA PNG without ancillary metadata', () => {
  const original = png()
  const marked = Buffer.concat([
    original.subarray(0, 33),
    chunk('tEXt', Buffer.from('Comment\0private-camera-metadata')),
    original.subarray(33),
  ])
  const clean = cleanAvatar(marked.toString('base64'))
  assert.ok(!clean.includes(Buffer.from('private-camera-metadata')))
  const image = PNG.sync.read(clean)
  assert.equal(image.width, 256)
  assert.equal(image.height, 256)
  assert.deepEqual(image.data, PNG.sync.read(original).data)
})
test('malformed PNG, wrong size, CRC, animated/interlaced images and inflation bombs are rejected before storage', () => {
  const corrupt = png()
  corrupt[corrupt.length - 1] ^= 1
  const animated = Buffer.concat([png().subarray(0, 33), chunk('acTL', Buffer.alloc(8)), png().subarray(33)])
  for (const value of [
    'data:image/png;base64,' + png().toString('base64'),
    Buffer.from('<svg/>').toString('base64'),
    corrupt.toString('base64'),
    PNG.sync.write({ width: 1, height: 1, data: Buffer.alloc(4) }).toString('base64'),
    crafted({ interlace: 1 }).toString('base64'),
    crafted({ idat: deflateSync(Buffer.alloc(1024 * 1024)) }).toString('base64'),
    crafted({ idat: deflateSync(Buffer.alloc(20)) }).toString('base64'),
    animated.toString('base64'),
    Buffer.concat([png(), Buffer.from('trailing')]).toString('base64'),
  ])
    assert.throws(() => cleanAvatar(value), /256 by 256 PNG/)
})
let hosted
after(() => hosted?.close())
test('hosted avatar APIs authorize only the signed-in user and keep existing profile on failed upload', async () => {
  hosted = await startHostedServer('hosted-avatar')
  const owner = await signUp(hosted, { handle: 'avatar-owner' })
  const signedOut = await import('./hosted-helpers.js').then(({ createBrowser }) => createBrowser(hosted.port, hosted.origin))
  assert.equal((await signedOut.call('PUT', '/auth/me/avatar', { body: { png: png().toString('base64') } })).status, 401)
  const result = await owner.browser.call('PUT', '/auth/me/avatar', { body: { png: png().toString('base64') } })
  assert.equal(result.status, 200, result.text)
  assert.match(result.json.avatarUrl, /^\/auth\/me\/avatar\?v=[a-f0-9]{64}$/)
  assert.equal((await owner.browser.get('/auth/me')).json.user.avatarUrl, result.json.avatarUrl)
  const image = await owner.browser.get(result.json.avatarUrl)
  assert.equal(image.status, 200)
  assert.match(image.headers['content-type'], /image\/png/)
  assert.equal(image.headers['cross-origin-resource-policy'], 'same-origin')
  const project = await createProject(owner, owner.workspaceId, 'Avatar fixture')
  const boardInfo = await owner.browser.get(`/w/${owner.workspaceId}/p/${project.id}/api/info`)
  assert.equal(boardInfo.status, 200)
  assert.equal(boardInfo.json.user.avatarUrl, result.json.avatarUrl)
  assert.equal((await owner.browser.call('PUT', '/auth/me/avatar', { body: { png: 'bad' } })).status, 400)
  assert.equal((await owner.browser.get('/auth/me')).json.user.avatarUrl, result.json.avatarUrl)
  assert.equal((await owner.browser.call('DELETE', '/auth/me/avatar', { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await owner.browser.call('DELETE', '/auth/me/avatar')).status, 200)
  assert.equal((await owner.browser.get('/auth/me')).json.user.avatarUrl, null)
  assert.equal((await owner.browser.get('/auth/me/avatar')).status, 404)
})
