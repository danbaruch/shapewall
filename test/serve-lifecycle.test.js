// `shapewall serve` start and stop: the update restart (exit 75) goes through
// the same graceful teardown as Ctrl-C, and serve.json liveness survives pid
// reuse.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { recordedServe, runningBoardUrl, writeServeState } from '../src/serve-state.js'
import { SAMPLE, request, sampleConfig, tempDir } from './helpers.js'

const cli = fileURLToPath(new URL('../bin/shapewall.js', import.meta.url))
const TOKEN = 'update-capability-0123456789abcdef'

test('the update restart exits 75 through the graceful stop: serve.json is cleared, the board stops cleanly', async () => {
  const dir = tempDir('serve-restart')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  const protocol = JSON.stringify({ latest: { version: '9.9.9', revision: 'abcdef1234567' }, updateAvailable: true, restartRequired: true })
  const helper = path.join(dir, 'update-helper')
  fs.writeFileSync(helper, `#!${process.execPath}\nconsole.log(${JSON.stringify(protocol)})\n`, { mode: 0o700 })
  const child = spawn(
    process.execPath,
    [cli, 'serve', '--engine', 'legacy', '--port', '0', '--no-chat', '--config', path.join(dir, 'shapewall.config.json')],
    {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        SHAPEWALL_UPDATE_RESTART: '1',
        SHAPEWALL_UPDATE_HELPER: helper,
        SHAPEWALL_UPDATE_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const exited = once(child, 'exit')
  let output = ''
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not start: ${output}`)), 15000)
      child.stdout.on('data', (chunk) => {
        output += chunk
        const match = /Shapewall is serving .* at https?:\/\/[^:]+:(\d+)\//.exec(output)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
      child.once('exit', () => reject(new Error(`serve exited: ${output}`)))
    })
    const serveFile = path.join(dir, '.shapewall', 'serve.json')
    // serve.json is written just after the first line.
    for (let i = 0; i < 200 && !fs.existsSync(serveFile); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fs.existsSync(serveFile), true)
    const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Update-Token': TOKEN }
    const post = (action) => request(port, 'POST', `/api/app-update/${action}`, { body: {}, headers })
    const settle = async () => {
      for (let i = 0; i < 200; i++) {
        const { json } = await request(port, 'GET', '/api/app-update', { headers })
        if (json.job?.state !== 'running') return json
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('the helper did not finish')
    }
    assert.equal((await post('check')).status, 202)
    assert.equal((await settle()).job.state, 'succeeded')
    assert.equal((await post('apply')).status, 202)
    const [code] = await exited
    assert.equal(code, 75)
    assert.equal(fs.existsSync(serveFile), false, 'the teardown ran (serve.json cleared)')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('serve.json: a recycled pid is not a running server', () => {
  const config = sampleConfig('serve-state-reuse')
  assert.equal(writeServeState(config, 'http://127.0.0.1:4777/'), true)
  assert.equal(runningBoardUrl(config), 'http://127.0.0.1:4777/')
  const file = path.join(config.outputDir, 'serve.json')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (state.start === null) return // no /proc start times here: the pid alone decides
  // Same pid (alive), another start time: a crashed server's pid now in use.
  fs.writeFileSync(file, JSON.stringify({ ...state, start: '1' }))
  assert.equal(runningBoardUrl(config), null)
  assert.equal(recordedServe(config).alive, false)
  assert.equal(recordedServe(config).port, 4777, 'still says which port it was')
  // A file from an older Shapewall (no start time): the pid decides, as before.
  const { start, ...legacy } = state
  assert.equal(typeof start, 'string')
  fs.writeFileSync(file, JSON.stringify(legacy))
  assert.equal(runningBoardUrl(config), 'http://127.0.0.1:4777/')
})
