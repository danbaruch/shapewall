// The mark on every agent process Shapewall starts: ACP sessions (chat and
// fix), the starter agent, `watch --exec`, `shapewall mcp` (and so the
// plugin launcher's child) and what each of them starts. Inside it,
// `shapewall comments add` signs "agent" and stores the comment as an
// agent's (authorAgent, never the owner stamp byOwner), and an agent that
// posts to the local board's HTTP API itself is given the header to send
// (SHAPEWALL_AGENT_HEADER), which the server reads the same way.
//
// This only marks what Shapewall started. A process Shapewall did not start
// (an agent app you opened yourself, a script) carries no mark unless its
// MCP server is Shapewall's, and a header-less HTTP post from it cannot be
// told apart from yours. An agent can also drop the mark from its own
// commands; the mark keeps honest agent text from passing as yours, it is
// not a boundary against an agent that hides it.

import { AGENT_HEADER } from './agent/triggers.js'

export const AGENT_RUN_VAR = 'SHAPEWALL_AGENT_RUN'
export const AGENT_HEADER_VAR = 'SHAPEWALL_AGENT_HEADER'

// The variables to add to an agent process's environment.
export const agentRunEnv = () => ({ [AGENT_RUN_VAR]: '1', [AGENT_HEADER_VAR]: `${AGENT_HEADER}: 1` })

// The same, as ACP / MCP stdio server env entries ([{ name, value }]).
export const agentRunEnvEntries = () => Object.entries(agentRunEnv()).map(([name, value]) => ({ name, value }))

// A process an agent runs in: one with the mark above, the command
// `watch --exec` starts (SHAPEWALL_COMMENT_ID) or the board's own agent's
// MCP server (SHAPEWALL_SERVER_HOLDER).
export const runByAgent = (env = process.env) =>
  Boolean(env[AGENT_RUN_VAR] || env.SHAPEWALL_COMMENT_ID || env.SHAPEWALL_SERVER_HOLDER)
