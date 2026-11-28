// `serve` flags on the solo engine (gap G20), enforced before the board
// routes (src/hosted/app.js mounts this early, on the owner's app and on its
// team listener). Matched case-insensitively, as Express routes are (A-2):
//
//   --read-only   the board in the browser makes no changes: every write on
//                 the members' board API answers 403 read_only, and the
//                 board's /info says readOnly (the client hides the
//                 controls). As on a local board, the command line still
//                 writes (the token API: push, comments, agents).
//   --no-chat     no board chat: the chat routes (threads, permissions)
//                 answer 403 chat_off. Connected agents still take comments.
//   --no-capture  solo.allowCapture = false: capture.js mounts nothing (no
//                 capture from the board, no recapture_pages on /mcp).
//
// solo: { readOnly, chat } from src/hosted/solo/serve.js.
const BOARD_API = /^\/w\/[^/]+\/p\/[^/]+\/api(\/.*)?$/i
const CHAT = /^\/boards\/[^/]+\/(?:threads|permissions)(?:\/|$)/i

export function soloFlagGate(solo = {}) {
  const readOnly = solo.readOnly === true
  const noChat = solo.chat === false
  if (!readOnly && !noChat) return null
  return (req, res, next) => {
    const match = BOARD_API.exec(req.path)
    if (!match) return next()
    const rest = match[1] || '/'
    if (noChat && CHAT.test(rest))
      return res.status(403).json({ error: { code: 'chat_off', message: 'Chat is off on this board (shapewall serve --no-chat).' } })
    if (!readOnly) return next()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      return res.status(403).json({ error: { code: 'read_only', message: 'This board is read-only (shapewall serve --read-only).' } })
    if (/^\/info\/?$/i.test(rest)) {
      const json = res.json.bind(res)
      res.json = (body) => json(res.statusCode === 200 && body && typeof body === 'object' ? { ...body, readOnly: true } : body)
    }
    next()
  }
}
