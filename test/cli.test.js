import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { allowedHostsFor, main, parseArgs } from '../src/cli.js'
import { createComment } from '../src/store.js'
import { loadConfig } from '../src/config.js'
import { SAMPLE, tempDir } from './helpers.js'

async function run(argv) {
  const lines = []
  const code = await main(argv, { out: (line) => lines.push(line) })
  return { code, text: lines.join('\n') }
}

test('parseArgs handles flags, values, = and repeatable options', () => {
  const parsed = parseArgs(['capture', '--board', 'site', '--only', 'home,pricing', '--only=/blog/', '--json'])
  assert.equal(parsed.command, 'capture')
  assert.equal(parsed.flags.board, 'site')
  assert.deepEqual(parsed.flags.only, ['home', 'pricing', '/blog/'])
  assert.equal(parsed.flags.json, true)
  assert.throws(() => parseArgs(['serve', '--port']), /needs a value/)
})

test('explicit false never enables diagnostic transfer, accounts or SEO', () => {
  for (const command of ['export', 'push', 'share']) {
    assert.equal(parseArgs([command, '--include-checks=false'], { strict: true }).flags['include-checks'], false)
    assert.equal(parseArgs([command, '--include-checks=true'], { strict: true }).flags['include-checks'], true)
    assert.throws(() => parseArgs([command, '--include-checks=maybe'], { strict: true }), /only true or false/)
  }
  assert.equal(parseArgs(['serve', '--accounts=false'], { strict: true }).flags.accounts, false)
  assert.equal(parseArgs(['checks', '--seo=false'], { strict: true }).flags.seo, false)
  assert.equal(parseArgs(['auth', 'record', '--overwrite=false'], { strict: true }).flags.overwrite, false)
  assert.equal(parseArgs(['serve', '--tailscale=print'], { strict: true }).flags.tailscale, 'print')
  assert.equal(parseArgs(['serve', '--lan=eth0'], { strict: true }).flags.lan, 'eth0')
})

test('help and version', async () => {
  assert.match((await run(['--help'])).text, /shapewall capture|capture every page/)
  assert.match((await run(['--version'])).text, /^\d+\.\d+\.\d+$/)
  await assert.rejects(run(['explode']), /unknown command/)
})

test('init writes a valid config and keeps outputs out of git', async () => {
  const dir = tempDir('cli-init')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/')
  const { text } = await run(['init', '--config', file, '--base-url', 'http://localhost:5173', '--no-discover'])
  assert.match(text, /Wrote/)
  assert.equal(loadConfig(file).boards[0].baseUrl, 'http://localhost:5173')
  const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
  assert.match(gitignore, /^node_modules\/\n# Shapewall\n\.shapewall\/\n/m)
  await assert.rejects(run(['init', '--config', file]), /already exists/)
})

test('comments: list as text and JSON, then resolve with a note', async () => {
  const dir = tempDir('cli-comments')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  const config = loadConfig(file)
  await createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'phone',
    x: 50,
    y: 10,
    body: 'Price cards overlap',
    anchor: { selector: 'div:nth-of-type(2) > section:nth-of-type(1)', text: 'Plus', dx: 0.1, dy: 0.2 },
  })
  const listed = await run(['comments', '--config', file])
  assert.match(listed.text, /#1 \[open\] Pricing \(\/pricing\) -- phone 390x1800/)
  assert.match(listed.text, /element: div:nth-of-type\(2\) > section:nth-of-type\(1\)/)
  const json = JSON.parse((await run(['comments', '--config', file, '--json'])).text)
  assert.equal(json.count, 1)
  assert.equal(json.comments[0].position.x, 195)
  assert.equal(json.comments[0].page.url, 'http://127.0.0.1:9/pricing')
  assert.equal(json.comments[0].files.screenshot, null)
  assert.equal(json.comments[0].captureVersion, null, 'nothing was captured when the comment was made')
  assert.equal(json.comments[0].fixRef, null)
  const ref = 'https://github.com/example/site/pull/7'
  assert.match((await run(['comments', 'resolve', '1', '--note', 'Fixed grid gap', '--ref', ref, '--config', file])).text, /#1 is resolved/)
  assert.match((await run(['comments', '--config', file])).text, /No open comments/)
  assert.match((await run(['comments', '--all', '--config', file])).text, /fixed by: https:\/\/github\.com\/example\/site\/pull\/7/)
  const all = JSON.parse((await run(['comments', '--all', '--json', '--config', file])).text)
  assert.equal(all.comments[0].resolution, 'Fixed grid gap')
  assert.equal(all.comments[0].fixRef, ref)
})

test('journeys: text shows forks and branches, JSON has steps, pages and paths', async () => {
  const dir = tempDir('cli-journeys')
  const file = path.join(dir, 'shapewall.config.json')
  assert.match((await run(['journeys', '--config', writeConfig(file, [])])).text, /No journeys on board "sample"/)
  const journeys = [
    { id: 'signup', name: 'Sign up', steps: ['home', 'pricing'] },
    {
      id: 'checkout',
      name: 'Checkout',
      description: 'Pay, or the card is declined',
      steps: [
        'pricing',
        {
          branches: [
            { label: 'Payment ok', steps: ['app'] },
            { id: 'declined', label: 'Card declined', steps: ['home'], end: true },
          ],
        },
      ],
    },
  ]
  writeConfig(file, journeys)
  const { text } = await run(['journeys', '--config', file])
  assert.match(text, /^Sign up \(signup, config\)\n {2}- Home \(home\)\n {2}- Pricing \(pricing\)$/m)
  assert.match(text, /Checkout \(checkout, config, 2 paths\)\n {2}Pay, or the card is declined/)
  assert.match(
    text,
    /fork:\n {6}> Payment ok \[payment-ok\]\n {8}- App \(app\)\n {6}> Card declined \[declined, ends here\]\n {8}- Home \(home\)/,
  )
  const json = JSON.parse((await run(['journeys', 'list', '--json', '--config', file])).text)
  assert.equal(json.board, 'sample')
  assert.deepEqual(
    json.journeys.map((item) => [item.id, item.branching, item.paths.length]),
    [
      ['signup', false, 1],
      ['checkout', true, 2],
    ],
  )
  assert.equal(json.journeys[1].paths[1].ended, true)
  await assert.rejects(run(['journeys', 'add', '--config', file]), /unknown journeys action/)
})

function writeConfig(file, journeys) {
  fs.writeFileSync(file, JSON.stringify({ ...SAMPLE, journeys }))
  return file
}

test('allowed Host names: local by default, env and flags add names, "*" turns the check off', () => {
  assert.ok(allowedHostsFor('127.0.0.1').has('localhost'))
  assert.equal(allowedHostsFor('0.0.0.0'), null)
  // The Docker image: bound to every address, the check stays on for local names.
  const docker = allowedHostsFor('0.0.0.0', [], 'localhost, 127.0.0.1')
  assert.ok(docker.has('localhost') && !docker.has('attacker.example'))
  assert.ok(allowedHostsFor('0.0.0.0', ['Board.Example.com'], '').has('board.example.com'))
  assert.equal(allowedHostsFor('0.0.0.0', [], 'localhost,*'), null)
  assert.equal(allowedHostsFor('127.0.0.1', ['*']), null)
})
