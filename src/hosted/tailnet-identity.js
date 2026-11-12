// Tailnet sign-in (`shapewall hosted --tailscale --tailnet-sign-in`): who a
// request is from. The proof that a request came through Tailscale's serve
// proxy is shared with the local board and lives in src/tailnet-proof.js
// (the serve secret, the owner of the connection's other end, tailscaled's
// own whois, clean headers, and the refusals); read its head for what each
// part stops and what is still trusted.
export {
  SECRET_PREFIX,
  TAILNET_LOGIN_RE,
  TAILSCALE_MIN_VERSION,
  cleanTailnetLogin,
  createTailnetGate,
  decodeHeaderValue,
  forwardedTailnetAddress,
  hostFacts,
  newServeSecret,
  parseIdentity,
  peerOwner,
  procAddress,
  procPeerProof,
  serveTarget,
  tailscaledProblem,
  whoisAnswer,
} from '../tailnet-proof.js'
