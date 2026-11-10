// Which ACP agents are installed on this machine, for the one-click Connect
// in an unconnected chat panel and the startup line of `shapewall serve`.
//
// Only PATH lookups: nothing is started, installed or downloaded here. Each
// agent is offered in the restricted form of the Settings > Agent buttons
// (client/src/settings/AgentSettings.jsx, docs/agent-hardening.md), and the
// command is this fixed list's, never one the board sends. The result is
// shown only on the token-protected settings route (src/agent/settings-routes.js)
// and in the terminal that runs `shapewall serve`.

import { lookupProgram } from '../../which.js'
import { loginHint } from './command.js'

// adapter: the program that speaks ACP. cli: the agent's own CLI, which on
// its own is not enough when an adapter is needed (Claude Code, Codex).
export const KNOWN_AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    adapter: 'claude-agent-acp',
    command: 'claude-agent-acp',
    cli: 'claude',
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
  },
  {
    id: 'codex',
    label: 'Codex',
    adapter: 'codex-acp',
    command: 'codex-acp',
    cli: 'codex',
    install: 'npm install -g @agentclientprotocol/codex-acp',
  },
  {
    id: 'goose',
    label: 'goose',
    adapter: 'goose',
    command: 'goose acp --with-builtin developer',
    cli: 'goose',
    install: null,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    adapter: 'gemini',
    command: 'gemini --acp',
    cli: 'gemini',
    install: 'npm install -g @google/gemini-cli',
  },
]

// [{ id, label, command, state, path, install, login }] for the agents
// found; agents with neither the adapter nor the CLI are left out. state:
// 'ready' (Connect works), 'needs-adapter' (the CLI without its ACP
// adapter), 'needs-shell' (Windows: only a .cmd/.bat wrapper, which needs a
// shell Shapewall never uses; point Settings > Agent at node and the
// adapter's script instead). Absolute PATH entries only (src/which.js).
export function detectAgents(env = process.env, { platform = process.platform } = {}) {
  const found = []
  for (const agent of KNOWN_AGENTS) {
    const adapter = lookupProgram(agent.adapter, env, { platform })
    const cli = agent.cli === agent.adapter ? adapter : lookupProgram(agent.cli, env, { platform })
    if (!adapter && !cli) continue
    const state = adapter?.runnable ? 'ready' : adapter ? 'needs-shell' : 'needs-adapter'
    found.push({
      id: agent.id,
      label: agent.label,
      command: agent.command,
      state,
      path: (adapter || cli).path,
      install: state === 'needs-adapter' ? agent.install : null,
      login: loginHint(agent.command.split(' ')),
    })
  }
  return found
}
