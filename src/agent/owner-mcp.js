// The ACP session receives this stdio server only for a trusted owner request.
// No GitHub actions, alternate boards, paths or credentials are accepted.
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createMcpServer } from '../mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export function ownerMcpServers(config, boardId, { allowCapture = true } = {}) {
  if (!config.file) return []
  return [
    {
      name: 'shapewall',
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), config.file, boardId, allowCapture ? 'capture' : 'no-capture'],
      env: [],
    },
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.argv[2])
  const server = createMcpServer({
    config,
    boardId: process.argv[3],
    allowCapture: process.argv[4] === 'capture',
    toolNames: [
      'list_pages',
      'list_journeys',
      'list_comments',
      'get_comment',
      'reply_to_comment',
      'set_comment_status',
      'resolve_comment',
      'recapture_pages',
    ],
  })
  await server.connect(new StdioServerTransport())
}
