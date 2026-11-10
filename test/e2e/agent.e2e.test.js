// End to end: an agent recaptures a page through the MCP server and gets a
// crop of the real Chromium screenshot around a comment.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { decodePng } from '../../src/png.js'
import { createComment } from '../../src/store.js'
import { ROOT_DIR, demoSetup } from './helpers.js'

let setup
let client

before(async () => {
  setup = await demoSetup('agent-e2e')
  client = new Client({ name: 'shapewall-e2e', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT_DIR, 'bin', 'shapewall.js'), 'mcp', '--config', setup.config.file],
      stderr: 'pipe',
    }),
  )
})

after(async () => {
  await client?.close()
  await setup?.close()
})

test('recapture_pages captures through MCP, get_comment crops the real screenshot', async () => {
  const result = await client.callTool({ name: 'recapture_pages', arguments: { pageIds: ['pricing'] } })
  assert.notEqual(result.isError, true, result.content[0].text)
  const summary = JSON.parse(result.content[0].text)
  assert.equal(summary.ok, true)
  assert.deepEqual(summary.pages.pricing, { desktop: 'ok', phone: 'ok' })
  const captures = path.join(setup.config.outputDir, 'demo', 'captures')
  assert.ok(fs.existsSync(path.join(captures, 'pricing.desktop.png')))
  assert.equal(fs.existsSync(path.join(captures, 'home.desktop.png')), false, 'only the asked-for page')

  await createComment(setup.config, setup.config.boards[0], {
    pageId: 'pricing',
    viewport: 'phone',
    x: 50,
    y: 20,
    body: 'Plus card is cramped on phones',
  })
  const comment = await client.callTool({ name: 'get_comment', arguments: { id: 1 } })
  const image = comment.content.find((item) => item.type === 'image')
  const crop = decodePng(Buffer.from(image.data, 'base64'))
  assert.deepEqual([crop.width, crop.height], [390, 700])
  assert.ok(new Set(crop.pixels).size > 10, 'the crop has content')
})
