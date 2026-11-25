import { ACCOUNT_LIMITS } from '../shared/ratelimit.js'
export { createRateLimiter } from '../shared/ratelimit.js'

// Default limits. Ceremonies are cheap for people (one or two per sign-in)
// and expensive to abuse; recovery codes get the tightest limit.
export const LIMITS = {
  ...ACCOUNT_LIMITS,
  // POST /auth/tailnet/sign-in, per tailnet login.
  tailnetSignIn: { limit: 30, windowMs: 60_000 },
  invite: { limit: 30, windowMs: 60_000 },
  // The console and board APIs per signed-in account (every tab of theirs
  // counts together: a board polls its view, comments and approvals). A
  // board's images, live pages and element maps have their own, larger
  // bucket: a big board loads hundreds of them at once.
  session: { limit: 1200, windowMs: 60_000 },
  sessionFiles: { limit: 6000, windowMs: 60_000 },
  token: { limit: 1200, windowMs: 60_000 },
  tokenBadAuth: { limit: 20, windowMs: 60_000 },
  // A connected agent's link (src/hosted/agent-link.js): streamed answers
  // arrive in small batches, in a bucket of their own so they never use up
  // the token's budget for comments and pushes.
  agentLink: { limit: 6000, windowMs: 60_000 },
  // How often one agent's link may open (each open is a write and a broadcast).
  agentLinkOpen: { limit: 6, windowMs: 60_000 },
  // Chat messages a person sends to connected agents (src/hosted/chat-routes.js).
  chatSend: { limit: 20, windowMs: 60_000 },
  push: { limit: 20, windowMs: 60 * 60_000 },
  // Invite emails per workspace (the link can always be copied instead).
  inviteEmail: { limit: 20, windowMs: 60 * 60_000 },
  inviteEmailUser: { limit: 50, windowMs: 24 * 60 * 60_000 },
  inviteEmailServer: { limit: 500, windowMs: 24 * 60 * 60_000 },
  // Share links: preview and open per IP; wrong passcodes per link and IP
  // and per IP (only failures count); a guest's API calls per link; guest
  // comments and replies per link and IP.
  share: { limit: 30, windowMs: 60_000 },
  shareFail: { limit: 5, windowMs: 15 * 60_000 },
  shareFailIp: { limit: 30, windowMs: 60 * 60_000 },
  // Wrong passcodes for one link from anywhere: a spread-out guesser stops
  // too (the cost: the link's own guests wait out the hour).
  shareFailLink: { limit: 50, windowMs: 60 * 60_000 },
  guestApi: { limit: 600, windowMs: 60_000 },
  guestComment: { limit: 30, windowMs: 60 * 60_000 },
  // New comments per API token (the add_comment MCP tool): a looping agent
  // stops long before it fills a board (replies stay on the token budget).
  tokenComment: { limit: 120, windowMs: 60 * 60_000 },
  // A public project's board API, per client address.
  publicApi: { limit: 600, windowMs: 60_000 },
  // `shapewall login`: starting a login and polling it per IP, and looking up
  // a code in the console per account (a code is guessed one try at a time).
  deviceStart: { limit: 10, windowMs: 60_000 },
  devicePoll: { limit: 60, windowMs: 60_000 },
  deviceLookup: { limit: 10, windowMs: 60_000 },
  // Workspace exports per person (each is a zip of everything).
  export: { limit: 5, windowMs: 60 * 60_000 },
  // Usage, activity and access review downloads, per person.
  usageExport: { limit: 30, windowMs: 60 * 60_000 },
  // Activity searches and filters by agent or project (they read the log entry by entry), per person.
  activitySearch: { limit: 60, windowMs: 60_000 },
}
