// How long a connection test may take, in one place for the server that
// runs it and the board that waits for it.
//
// A one-click Connect (and Test connection) starts the agent and waits for
// its ACP handshake. The stub used in tests answers at once; a real agent
// takes several seconds, and up to ACP_TEST_TIMEOUT_MS before the server
// gives up. While it runs the server takes no chat message and no other
// settings change, so the board waits rather than showing an error: for a
// little longer than the test can last (TEST_WAIT_MS).
//
// No Node imports: the board imports this file too.

export const ACP_TEST_TIMEOUT_MS = 30000
export const TEST_WAIT_MS = ACP_TEST_TIMEOUT_MS + 15000
