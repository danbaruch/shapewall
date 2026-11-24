import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { checkBrowser, checkResolver } from '../src/checks/egress.js'

const records = (...addresses) => addresses.map((address) => ({ address }))

test('page checks pin their configured public origin and select only public socket addresses elsewhere', async () => {
  const answers = new Map([
    ['board.example', records('1.1.1.1')],
    ['assets.example', records('8.8.8.8', '2001:4860:4860::8888')],
    ['mixed.example', records('8.8.8.8', '10.0.0.1')],
    ['empty.example', []],
  ])
  const calls = []
  const lookup = async (host, options) => {
    assert.equal(options.all, true)
    calls.push(host)
    if (!answers.has(host)) throw new Error('Unknown host')
    return answers.get(host)
  }
  const select = await checkResolver('https://board.example', lookup)
  assert.deepEqual(await select('board.example', 443, 'https:'), { address: '1.1.1.1' })
  assert.deepEqual(calls, ['board.example'])
  assert.deepEqual(await select('assets.example', 443, 'https:'), { address: '8.8.8.8' })
  for (const host of ['localhost', '[::1]', '10.0.0.1', 'mixed.example', 'empty.example', 'unknown.example']) {
    assert.ok((await select(host, 80, 'http:')).reason)
  }
  await assert.rejects(checkResolver('https://mixed.example', lookup), /non-public/)
  await assert.rejects(checkResolver('https://empty.example', lookup), /No address/)
})

test('local board URLs keep their browser and DNS-named development boards get their configured origin', async () => {
  const browser = {}
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'workstation.lan']) {
    assert.deepEqual(await checkBrowser(browser, `http://${host}`, assert.fail), { browser })
  }
  const select = await checkResolver('http://preview.example:3200', async () => records('192.168.1.2'))
  assert.deepEqual(await select('preview.example', 3200, 'http:'), { address: '192.168.1.2' })
  assert.ok((await select('preview.example', 80, 'http:')).reason)
  assert.ok((await select('preview.example', 3200, 'https:')).reason)
})

test('guarded contexts keep loopback in proxy scope and run cleanup closes an open connection', async () => {
  let options
  const browser = { newContext: (value) => (options = value) }
  const scoped = await checkBrowser(browser, 'https://board.example', async () => records('1.1.1.1'))
  let closed
  try {
    await scoped.browser.newContext({ locale: 'en-US' })
    assert.equal(options.locale, 'en-US')
    assert.equal(options.proxy.bypass, '<-loopback>')
    const url = new URL(options.proxy.server)
    assert.equal(url.hostname, '127.0.0.1')
    const socket = net.connect(Number(url.port), url.hostname)
    await once(socket, 'connect')
    closed = once(socket, 'close')
  } finally {
    await scoped.close()
  }
  await closed
})
