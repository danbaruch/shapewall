// An error a chat run reports to the board: a code and a message that is safe
// to show (no secret, no stack).
export class AgentError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}
