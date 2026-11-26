// The ACP session receives this stdio server only for a trusted owner request.
// No GitHub actions, alternate boards, paths or credentials are accepted.
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createMcpServer } from '../mcp.js'
import { SETTINGS_FILE_VAR, savedAgentName } from './user-settings.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { processStartTime } from '../lock.js'
import { agentRunEnvEntries } from '../agent-run.js'

// The Shapewall server that runs this agent (pid:start). While that server
// runs a fix on a comment it holds the comment's claim, and the turn's end
// writes its status (branch-ready, done, needs-human): this MCP server's
// status writes to such a comment are refused (src/mcp.js), so the agent
// cannot take the fix's claim from under it.
export const SERVER_HOLDER_VAR = 'SHAPEWALL_SERVER_HOLDER'

export function parseServerHolder(value) {
  const match = /^([1-9][0-9]{0,9}):([0-9]{0,32})$/.exec(String(value || ''))
  return match ? { pid: Number(match[1]), start: match[2] || null } : null
}

// `agent`: { which, name } (routes.js): which saved agent this session runs
// ("fixed", "default" or a profile id) and what it was called when the
// session started. Its replies are signed with the name it has when it
// replies (user-settings.js savedAgentName), so a rename shows on the next
// reply without restarting the agent; the starting name is the fallback.
//
// `ownersOnly`: a session for turns above "open" (routes.js, by the turn's
// tier): its board reads give the owner's own comments only (mcp.js, Q7 N1).
// The list says so (`ownersOnly`), so the ACP backend knows those reads bring
// no one else's text in (acp.js, no taint for them).
export function ownerMcpServers(config, boardId, { allowCapture = true, agent = null, env = process.env, ownersOnly = false } = {}) {
  if (!config.file) return []
  const settingsFile = env[SETTINGS_FILE_VAR]
  const servers = [
    {
      name: 'shapewall',
      command: process.execPath,
      args: [
        fileURLToPath(import.meta.url),
        config.file,
        boardId,
        allowCapture ? 'capture' : 'no-capture',
        ownersOnly ? 'owners' : 'all',
        ...(agent?.name ? [agent.which || 'default', agent.name] : []),
      ],
      // The agent's small environment may not name the settings file.
      env: [
        ...(settingsFile ? [{ name: SETTINGS_FILE_VAR, value: settingsFile }] : []),
        { name: SERVER_HOLDER_VAR, value: process.pid + ':' + (processStartTime(process.pid) ?? '') },
        ...agentRunEnvEntries(),
      ],
    },
  ]
  servers.ownersOnly = ownersOnly === true
  return servers
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.argv[2])
  const [which, startName] = process.argv.slice(6)
  const server = createMcpServer({
    config,
    agentAuthor: startName ? () => savedAgentName(config.dir, which) || startName : null,
    boardId: process.argv[3],
    fixServer: parseServerHolder(process.env[SERVER_HOLDER_VAR]),
    allowCapture: process.argv[4] === 'capture',
    // Anything but "all" reads as the owner's own comments only.
    ownersOnly: process.argv[5] !== 'all',
    toolNames: [
      'list_pages',
      'list_journeys',
      'list_comments',
      'get_comment',
      'board_link',
      'compare_captures',
      'reply_to_comment',
      'set_comment_status',
      'resolve_comment',
      'recapture_pages',
    ],
  })
  await server.connect(new StdioServerTransport())
}
