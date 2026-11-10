// An error a chat run reports to the board: a code and a message that is safe
// to show (no secret, no stack).
export class AgentError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}

// Errors that mean the agent never got to work: it is not logged in or set
// up (agent_auth, from acp.js authError or an endpoint refusing the key), or
// it could not be started or found. Nothing was attempted, so a Fix with
// agent run leaves the comment as it was (feedback-loop.js finishFix), and
// the chat offers another connected agent (client/src/chat/profiles.js).
export const SETUP_ERROR_CODES = new Set(['agent_auth', 'agent_start', 'agent_not_found'])
export const isSetupError = (error) => SETUP_ERROR_CODES.has(error?.code)
