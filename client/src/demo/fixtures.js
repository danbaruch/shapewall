// The public demo's fictional workspace, "Lumen": six people across every
// role (and one who left), pending and past invites, share links, API
// tokens, two projects and an audit history. Every name, address and host is
// made up (example.com addresses, documentation IP ranges). Times are
// relative to the moment a visitor first opens the demo, so nothing reads as
// weeks old; the board's own comments and captures come from the export
// (data/boards/<board>/...), moved onto the same clock (timeShift).

const DAY = 86_400_000
const HOUR = 3_600_000

// Ids in the server's formats (<prefix>_ + 24 hex), fixed so links keep working.
export const fixedId = (prefix, n) => `${prefix}_4c756d${n.toString(16).padStart(18, '0')}`

export const WORKSPACE_ID = fixedId('ws', 1)
export const SANDBOX_ID = fixedId('ws', 2)
export const NOTES_PROJECT = fixedId('pr', 1)
export const WEBSITE_PROJECT = fixedId('pr', 2)
export const REVIEW_SHARE = fixedId('sh', 1)
// The workspace's agents as the Usage and Activity pages know them (an agent
// there is "ag_..."): the two scripted ones the board runs, the coding agent
// whose token is on the API tokens page, and one for the website project.
// Their fictional machines, models and history are in usage/world.js.
export const DEMO_AGENT_IDS = { demo: fixedId('ag', 1), second: fixedId('ag', 2), coding: fixedId('ag', 3), website: fixedId('ag', 4) }

// The board in the export, and the second project's board made from part of it.
export const EXPORT_BOARD = 'demo'
export const WEBSITE_BOARD = 'website'
export const WEBSITE_GROUPS = ['Marketing', 'Content']

// The same choices the server offers (test/demo-backend.test.js checks them).
export const INVITE_DAYS = [1, 3, 7, 14, 30]
export const SHARE_DAYS = [1, 7, 30, 90]
export const TOKEN_SCOPES = ['read', 'reply', 'status', 'claim', 'resolve', 'push']

export const USERS = [
  { id: fixedId('us', 1), handle: 'robin', displayName: 'Robin Ash' },
  { id: fixedId('us', 2), handle: 'jo', displayName: 'Jo Park' },
  { id: fixedId('us', 3), handle: 'priya', displayName: 'Priya Nair' },
  { id: fixedId('us', 4), handle: 'mei', displayName: 'Mei Lin' },
  { id: fixedId('us', 5), handle: 'sam', displayName: 'Sam Ortiz' },
  { id: fixedId('us', 6), handle: 'alex', displayName: 'Alex Kim' },
  // Left the workspace; a token they made was kept, so it is inactive (flagged).
  { id: fixedId('us', 7), handle: 'lee', displayName: 'Lee Chan' },
]
const user = (handle) => USERS.find((item) => item.handle === handle).id

// "View as": who the visitor is for each choice. People are picked by the
// role they have now (first in this order), so a role changed in the console
// shows up here too. The guest opens the comment share link.
export const VIEW_AS = [
  { id: 'owner', label: 'Owner' },
  { id: 'admin', label: 'Admin' },
  { id: 'member', label: 'Member' },
  { id: 'viewer', label: 'Viewer' },
  { id: 'guest', label: 'Guest', hint: 'share link' },
]
export const PERSONA_ORDER = ['robin', 'jo', 'priya', 'mei', 'sam', 'alex']
export const GUEST_NAME = 'Taylor'

// The comment authors in the export, as accounts (and the coding agent's token).
export const EXPORT_AUTHORS = { Robin: 'robin', Jo: 'jo', Mei: 'mei', Sam: 'sam' }
export const EXPORT_AGENT = 'Coding agent'

// fixturesAt: the moment the export's times stand for (data/info.json); the
// backend moves them by timeShift so they sit on the same clock as these.
export const STATE_VERSION = 2
export function seedState(now = Date.now(), { fixturesAt = null } = {}) {
  const at = (days) => new Date(now - days * DAY).toISOString()
  const ahead = (days) => new Date(now + days * DAY).toISOString()
  let auditId = 0
  const audit = []
  const log = (days, action, { by = null, token = null, share = null, target = null, detail = {}, ip = '198.51.100.24' } = {}) =>
    audit.push({
      id: ++auditId,
      workspaceId: WORKSPACE_ID,
      action,
      target,
      userId: by ? user(by) : null,
      tokenId: token,
      shareId: share,
      detail,
      ip,
      at: at(days),
    })

  const memberships = [
    ['robin', 'owner', 40, 0.05],
    ['jo', 'admin', 38, 0.3],
    ['priya', 'admin', 30, 1.2],
    ['mei', 'member', 36, 0.6],
    ['sam', 'member', 35, 2.1],
    ['alex', 'viewer', 12, 3.5],
  ].map(([handle, role, joined, active]) => ({
    workspaceId: WORKSPACE_ID,
    userId: user(handle),
    role,
    createdAt: at(joined),
    lastActiveAt: at(active),
  }))
  memberships.push({ workspaceId: SANDBOX_ID, userId: user('robin'), role: 'owner', createdAt: at(20), lastActiveAt: at(4) })

  const tokens = [
    { n: 1, project: NOTES_PROJECT, name: 'CI push', prefix: 'swp_Lm3kQ9aZ', scopes: ['push', 'read'], by: 'robin', made: 33, used: 2 },
    {
      n: 2,
      project: NOTES_PROJECT,
      name: 'Coding agent',
      prefix: 'swp_7xRb2NqE',
      scopes: ['comment', 'read', 'resolve'],
      by: 'jo',
      made: 21,
      used: 0.1,
    },
    { n: 3, project: WEBSITE_PROJECT, name: 'Website CI', prefix: 'swp_Hq8vT1mW', scopes: ['push', 'read'], by: 'lee', made: 25, used: 5 },
    {
      n: 4,
      project: NOTES_PROJECT,
      name: 'Old laptop',
      prefix: 'swp_c4Ye0LpS',
      scopes: ['read'],
      by: 'robin',
      made: 30,
      used: 9,
      revoked: 6,
    },
  ].map((item) => ({
    id: fixedId('tk', item.n),
    workspaceId: WORKSPACE_ID,
    projectId: item.project,
    name: item.name,
    prefix: item.prefix,
    scopes: item.scopes,
    createdBy: user(item.by),
    createdAt: at(item.made),
    expiresAt: null,
    lastUsedAt: at(item.used),
    revokedAt: item.revoked ? at(item.revoked) : null,
  }))

  const shares = [
    {
      id: REVIEW_SHARE,
      projectId: NOTES_PROJECT,
      name: 'Design review (agency)',
      mode: 'comment',
      passcode: false,
      by: 'jo',
      made: 6,
      expires: ahead(24),
      opens: 7,
      used: 0.8,
    },
    {
      id: fixedId('sh', 2),
      projectId: WEBSITE_PROJECT,
      name: 'Investor preview',
      mode: 'view',
      passcode: true,
      by: 'robin',
      made: 3,
      expires: ahead(4),
      opens: 2,
      used: 1.5,
    },
    {
      id: fixedId('sh', 3),
      projectId: NOTES_PROJECT,
      name: 'Old agency link',
      mode: 'view',
      passcode: false,
      by: 'priya',
      made: 18,
      expires: ahead(12),
      opens: 11,
      used: 4,
      revoked: 3,
    },
  ].map((item) => ({
    id: item.id,
    workspaceId: WORKSPACE_ID,
    projectId: item.projectId,
    name: item.name,
    mode: item.mode,
    passcode: item.passcode,
    createdBy: user(item.by),
    createdAt: at(item.made),
    expiresAt: item.expires,
    revokedAt: item.revoked ? at(item.revoked) : null,
    lastUsedAt: at(item.used),
    opens: item.opens,
  }))

  const invites = [
    { n: 1, role: 'member', by: 'jo', made: 2, expires: ahead(5), email: 'casey@example.com', emailed: 2 },
    { n: 2, role: 'viewer', by: 'robin', made: 1, expires: ahead(2) },
    { n: 3, role: 'admin', by: 'robin', made: 0.5, expires: ahead(6.5) },
    { n: 4, role: 'viewer', by: 'jo', made: 14, expires: at(7), used: 12, usedBy: 'alex' },
    { n: 5, role: 'member', by: 'priya', made: 10, expires: at(3), revoked: 9 },
    { n: 6, role: 'member', by: 'jo', made: 20, expires: at(13), email: 'drew@example.com' },
  ].map((item) => ({
    id: fixedId('iv', item.n),
    workspaceId: WORKSPACE_ID,
    role: item.role,
    createdBy: user(item.by),
    createdAt: at(item.made),
    expiresAt: item.expires,
    usedAt: item.used ? at(item.used) : null,
    usedBy: item.usedBy ? user(item.usedBy) : null,
    revokedAt: item.revoked ? at(item.revoked) : null,
    email: item.email || null,
    emailedAt: item.emailed ? at(item.emailed) : null,
  }))

  // The workspace's history, oldest first.
  log(40, 'workspace_created', { by: 'robin' })
  log(39.9, 'project_created', { by: 'robin', target: NOTES_PROJECT })
  for (const [handle, role, days] of [
    ['jo', 'member', 38],
    ['mei', 'member', 36],
    ['sam', 'member', 35],
    ['lee', 'member', 34],
  ])
    log(days, 'invite_accepted', { by: handle, target: fixedId('iv', 90 + days), detail: { role }, ip: '203.0.113.7' })
  log(37, 'member_role_changed', { by: 'robin', target: user('jo'), detail: { from: 'member', to: 'admin' } })
  log(33, 'token_created', { by: 'robin', target: fixedId('tk', 1), detail: { project: NOTES_PROJECT, scopes: ['push', 'read'] } })
  log(31, 'invite_accepted', { by: 'priya', target: fixedId('iv', 91), detail: { role: 'admin' }, ip: '203.0.113.45' })
  log(30, 'token_created', { by: 'robin', target: fixedId('tk', 4), detail: { project: NOTES_PROJECT, scopes: ['read'] } })
  log(26, 'project_created', { by: 'jo', target: WEBSITE_PROJECT })
  log(25, 'token_created', { by: 'lee', target: fixedId('tk', 3), detail: { project: WEBSITE_PROJECT, scopes: ['push', 'read'] } })
  log(21, 'token_created', {
    by: 'jo',
    target: fixedId('tk', 2),
    detail: { project: NOTES_PROJECT, scopes: ['comment', 'read', 'resolve'] },
  })
  log(20, 'invite_created', { by: 'jo', target: fixedId('iv', 6), detail: { role: 'member', days: 7, emailed: true } })
  log(19, 'share_links_enabled', { by: 'priya' })
  log(18, 'share_created', { by: 'priya', target: fixedId('sh', 3), detail: { project: NOTES_PROJECT, mode: 'view', days: 30 } })
  log(16, 'member_left', { by: 'lee', target: user('lee'), detail: { role: 'member' } })
  log(14, 'invite_created', { by: 'jo', target: fixedId('iv', 4), detail: { role: 'viewer', days: 7 } })
  log(12, 'invite_accepted', { by: 'alex', target: fixedId('iv', 4), detail: { role: 'viewer' }, ip: '203.0.113.88' })
  log(10, 'invite_created', { by: 'priya', target: fixedId('iv', 5), detail: { role: 'member', days: 7 } })
  log(9, 'invite_revoked', { by: 'priya', target: fixedId('iv', 5) })
  log(6.1, 'token_revoked', { by: 'robin', target: fixedId('tk', 4) })
  log(6, 'share_created', { by: 'jo', target: REVIEW_SHARE, detail: { project: NOTES_PROJECT, mode: 'comment', days: 30 } })
  log(5, 'push_committed', { token: fixedId('tk', 3), target: WEBSITE_PROJECT, detail: { files: 48 }, ip: '192.0.2.10' })
  log(4.6, 'comment_resolved', {
    token: fixedId('tk', 2),
    target: `${EXPORT_BOARD}#6`,
    detail: { project: NOTES_PROJECT },
    ip: '192.0.2.10',
  })
  log(3, 'share_created', {
    by: 'robin',
    target: fixedId('sh', 2),
    detail: { project: WEBSITE_PROJECT, mode: 'view', days: 7, passcode: true },
  })
  log(3, 'share_revoked', { by: 'priya', target: fixedId('sh', 3), detail: { project: NOTES_PROJECT } })
  log(2.5, 'share_opened', { share: REVIEW_SHARE, target: REVIEW_SHARE, detail: { count: 4, guests: [GUEST_NAME] }, ip: '203.0.113.150' })
  log(2, 'invite_created', { by: 'jo', target: fixedId('iv', 1), detail: { role: 'member', days: 7, emailed: true } })
  log(2, 'push_committed', { token: fixedId('tk', 1), target: NOTES_PROJECT, detail: { files: 212 }, ip: '192.0.2.10' })
  log(1.6, 'comment_resolved', { by: 'robin', target: `${EXPORT_BOARD}#11`, detail: { project: NOTES_PROJECT } })
  log(1.5, 'share_passcode_failed', { share: fixedId('sh', 2), target: fixedId('sh', 2), detail: { count: 2 }, ip: '203.0.113.201' })
  log(1, 'invite_created', { by: 'robin', target: fixedId('iv', 2), detail: { role: 'viewer', days: 3 } })
  log(0.8, 'share_opened', { share: REVIEW_SHARE, target: REVIEW_SHARE, detail: { count: 3, guests: [GUEST_NAME] }, ip: '203.0.113.150' })
  log(0.5, 'invite_created', { by: 'robin', target: fixedId('iv', 3), detail: { role: 'admin', days: 7 } })

  // A copy: the backend changes its state in place (a renamed person, a
  // board's groups), so nothing here may be shared with the module or with
  // another backend's state.
  return structuredClone({
    version: STATE_VERSION,
    seededAt: new Date(now).toISOString(),
    timeShift: Number.isFinite(Date.parse(fixturesAt || '')) ? Math.max(0, now - Date.parse(fixturesAt)) : 0,
    viewAs: 'owner',
    guestName: GUEST_NAME,
    workspaces: [
      { id: WORKSPACE_ID, name: 'Lumen', createdAt: at(40), shareLinks: true },
      { id: SANDBOX_ID, name: "Robin's sandbox", createdAt: at(20), shareLinks: false },
    ],
    users: USERS,
    avatars: {},
    memberships,
    projects: [
      {
        id: NOTES_PROJECT,
        workspaceId: WORKSPACE_ID,
        name: 'Lumen Notes',
        slug: 'lumen-notes',
        createdAt: at(39.9),
        boards: [{ id: EXPORT_BOARD, folder: EXPORT_BOARD, pushedAt: at(2), pushes: 14 }],
      },
      {
        id: WEBSITE_PROJECT,
        workspaceId: WORKSPACE_ID,
        name: 'Lumen Website',
        slug: 'lumen-website',
        createdAt: at(26),
        boards: [{ id: WEBSITE_BOARD, folder: EXPORT_BOARD, groups: WEBSITE_GROUPS, title: 'Lumen website', pushedAt: at(5), pushes: 6 }],
      },
      { id: fixedId('pr', 3), workspaceId: SANDBOX_ID, name: 'Scratch', slug: 'scratch', createdAt: at(20), boards: [] },
    ],
    invites,
    tokens,
    shares,
    audit,
    nextAudit: auditId + 1,
    // Comments per board ("<project>/<board>"), seeded on first use.
    comments: {},
    threads: { [NOTES_PROJECT + '/' + EXPORT_BOARD + '/board']: seedThread(now), ...seedChats(now).threads },
    // Chat history fields per thread (backend/chat.js): owner, title, archived, earlier versions.
    threadMeta: seedChats(now).threadMeta,
    // Answer ratings per board ("<project>/<board>"): Console > Agent feedback.
    ratings: { [NOTES_PROJECT + '/' + EXPORT_BOARD]: seedRatings(now) },
    // Per person: the devices signed in (this one first) and passkeys.
    sessions: Object.fromEntries(
      USERS.map((item, index) => [
        item.id,
        [
          { id: fixedId('se', index * 2 + 1), device: 'Chrome on macOS', ip: '198.51.100.24', created: 9, seen: 0 },
          { id: fixedId('se', index * 2 + 2), device: 'Safari on iPhone', ip: '203.0.113.61', created: 20, seen: 1.4 },
        ].map((session, position) => ({
          id: session.id,
          current: position === 0,
          createdAt: at(session.created),
          lastSeenAt: at(session.seen),
          expiresAt: ahead(30 - session.seen),
          via: 'passkey',
          device: session.device,
          ip: session.ip,
        })),
      ]),
    ),
    passkeys: Object.fromEntries(
      USERS.map((item, index) => [
        item.id,
        [
          { id: fixedId('pk', index * 2 + 1), nickname: 'Laptop', created: 30, used: 0.05, synced: true },
          { id: fixedId('pk', index * 2 + 2), nickname: 'Phone', created: 28, used: 1.4, synced: true },
        ].map((key) => ({
          id: key.id,
          nickname: key.nickname,
          createdAt: at(key.created),
          lastUsedAt: at(key.used),
          synced: key.synced,
          deviceType: 'multiDevice',
          onHoldUntil: null,
        })),
      ]),
    ),
  })
}

// Comments on the second project's board (made from part of the export).
export function websiteComments(pages, now = Date.now()) {
  const at = (days) => new Date(now - days * DAY).toISOString()
  const has = (id) => pages.some((page) => page.id === id)
  const list = [
    {
      pageId: 'home',
      x: 50,
      y: 12,
      body: 'Hero copy for the launch: lead with "notes that keep up", not the feature list. @jo',
      author: 'robin',
      days: 3,
      replies: [['jo', 'Drafting two options for Thursday.', 2.8]],
      reactions: [['👍', ['jo', 'priya']]],
    },
    { pageId: 'pricing', x: 62, y: 30, body: 'Show the yearly price first on the website too.', author: 'priya', days: 2 },
    {
      pageId: 'blog',
      x: 30,
      y: 40,
      body: 'Cover images load slowly on phones. Smaller files?',
      author: 'mei',
      days: 1.2,
      status: 'resolved',
      resolution: 'Covers are WebP now.',
    },
    { pageId: 'features', x: 48, y: 22, body: 'The offline sync section needs a screenshot.', author: 'sam', days: 0.4 },
  ].filter((item) => has(item.pageId))
  return list.map((item, index) => ({
    id: index + 1,
    pageId: item.pageId,
    viewport: 'desktop',
    x: item.x,
    y: item.y,
    body: item.body,
    author: USERS.find((entry) => entry.handle === item.author).displayName,
    authorHandle: item.author,
    authorUserId: user(item.author),
    captureVersion: null,
    status: item.status || 'open',
    createdAt: at(item.days),
    updatedAt: at(item.days),
    resolvedAt: item.status === 'resolved' ? at(item.days - 0.2) : null,
    resolution: item.resolution || null,
    replies: (item.replies || []).map(([handle, body, days], position) => ({
      id: position + 1,
      author: USERS.find((entry) => entry.handle === handle).displayName,
      handle,
      body,
      createdAt: at(days),
    })),
    agentStatus: null,
    agentStatusAt: null,
    reopenCount: 0,
    reopenedAt: null,
    reactions: (item.reactions || []).map(([emoji, handles]) => ({
      emoji,
      by: handles.map((handle) => ({ name: USERS.find((entry) => entry.handle === handle).displayName, handle, user: user(handle) })),
    })),
  }))
}

// Earlier conversations for chat history (fictional): Robin's (the Owner
// persona) from today back to last week, one archived and one edited with an
// earlier version kept; and one of Jo's, which only View as Admin shows.
// Messages go in `threads`, history fields in `threadMeta` (backend/chat.js).
export function seedChats(now = Date.now()) {
  const at = (hours) => new Date(now - hours * HOUR).toISOString()
  // "Today" and "yesterday" are days of the viewer's calendar, not a number
  // of hours ago: just after midnight, two hours ago was yesterday. So the
  // chat of today is at most as old as today is, and yesterday's is from
  // yesterday evening, whatever the time is now.
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const sinceMidnight = (now - midnight.getTime()) / HOUR
  const today = Math.max(0.03, Math.min(2, sinceMidnight - 0.05))
  const yesterday = sinceMidnight + 5
  const base = `${NOTES_PROJECT}/${EXPORT_BOARD}/`
  const robin = `user:${user('robin')}`
  const jo = `user:${user('jo')}`
  const answer = (id, hours, text, cards = []) => ({
    id,
    role: 'assistant',
    text,
    cards,
    model: 'scripted',
    status: 'done',
    createdAt: at(hours),
  })
  const ask = (id, hours, text) => ({ id, role: 'user', text, attachments: [], createdAt: at(hours) })
  const tool = (id, label, detail) => ({ id, kind: 'tool', name: 'list_comments', label, state: 'done', detail })
  const chats = [
    {
      id: 'chat-seedreleasenote1',
      owner: robin,
      messages: [
        ask('msg_chat1a', today, 'Draft release notes for the pricing changes'),
        answer(
          'msg_chat1b',
          today - 0.02,
          '**Pricing, this release**\n\n- Plans sit side by side from tablet width up.\n- The Plus button has the stronger style (pull request 42).\n- The yearly toggle shows the saving as "2 months free".\n\nWant a shorter version for the changelog?',
          [tool('seed-chat1-tool', 'Read the comments on Pricing', '3 comments, 1 resolved')],
        ),
      ],
    },
    {
      id: 'chat-seedalttextaudt1',
      owner: robin,
      messages: [
        ask('msg_chat2a', yesterday, 'Which pages still miss alt text on their images?'),
        answer(
          'msg_chat2b',
          yesterday - 0.02,
          'From the latest captures, Home has two decorative images without alt text and Pricing has none missing. Decorative images can use an empty alt; the hero photo on Home needs a real description.',
          [tool('seed-chat2-tool', 'Checked the captured pages', '2 pages')],
        ),
      ],
    },
    {
      id: 'chat-seedonboardflow1',
      owner: robin,
      edited: true,
      messages: [
        ask('msg_chat3c', 96, 'Compare sign up on phone and desktop, step by step'),
        answer(
          'msg_chat3d',
          95.97,
          '1. **Start:** the desktop form fits on one screen; on a phone the plan picker pushes the button below the fold.\n2. **Email check:** the same on both.\n3. **First board:** the phone skips the welcome tour.\n\nThe phone loses people at step 1. Moving the plan picker after sign up would fix that.',
        ),
      ],
      branch: [
        ask('msg_chat3a', 97, 'Compare the onboarding flow on phone and desktop'),
        answer('msg_chat3b', 96.98, 'Onboarding is the same three steps on both. The phone shows a shorter welcome text.'),
      ],
    },
    {
      id: 'chat-seedemptystates1',
      owner: robin,
      archived: true,
      messages: [
        ask('msg_chat4a', 170, 'Ideas for the empty state on Notes?'),
        answer(
          'msg_chat4b',
          169.98,
          'Show one sample note the person can edit, a short line on what notes are for, and one button: New note.',
        ),
      ],
    },
    {
      id: 'chat-seedjosquestion1',
      owner: jo,
      messages: [
        ask('msg_chat5a', yesterday + 3, 'Is the footer the same on every page?'),
        answer('msg_chat5b', yesterday + 2.98, 'Yes. Every captured page has the same footer, with the same four links.'),
      ],
    },
  ]
  const threads = {}
  const threadMeta = {}
  for (const chat of chats) {
    threads[base + chat.id] = chat.messages
    threadMeta[base + chat.id] = {
      owner: chat.owner,
      title: chat.messages[0].text,
      titleSource: 'auto',
      createdAt: (chat.branch || chat.messages)[0].createdAt,
      ...(chat.archived ? { archived: true } : {}),
      ...(chat.branch
        ? { branches: [{ id: 'ver_seedonboard1', at: 0, messages: chat.branch, branches: [], createdAt: chat.messages[0].createdAt }] }
        : {}),
    }
  }
  return { threads, threadMeta }
}

// Fictional thumbs up and down on earlier answers, for the console's Agent
// feedback page: a few days of them, two agents, reasons and notes.
export function seedRatings(now = Date.now()) {
  const at = (hours) => new Date(now - hours * HOUR).toISOString()
  const demoAgent = { profileId: 'default', backend: 'demo', label: 'Demo agent', model: 'scripted' }
  const codingAgent = { profileId: 'coding', backend: 'acp', label: 'Coding agent', model: null }
  const rows = [
    [
      'robin',
      'up',
      [],
      '',
      demoAgent,
      4.9,
      'What is still open on the pricing page?',
      'Pricing has one open comment: Sam asks whether the plans can sit side by side on a tablet.',
      'msg_seed2',
      'board',
    ],
    [
      'sam',
      'down',
      ['ignored'],
      'I asked for the tablet layout, it only listed the comments.',
      demoAgent,
      20,
      'Suggest a tablet layout for the plans',
      'Pricing has three plans. Here are the open comments on the page.',
      'msg_rated01',
      'board',
    ],
    [
      'robin',
      'up',
      [],
      'Good, small change and it explained it.',
      codingAgent,
      28,
      'Fix this review comment in the project.',
      'Made the Plus button bolder (font-weight 600) and recaptured Pricing.',
      'msg_rated02',
      'comment-3',
    ],
    [
      'jo',
      'down',
      ['wrong'],
      'The toggle label is "-17%", not "-20%".',
      demoAgent,
      46,
      'What does the yearly toggle say?',
      'The yearly toggle says "Save 20%".',
      'msg_rated03',
      'board',
    ],
    [
      'priya',
      'down',
      ['slow', 'other'],
      '',
      codingAgent,
      70,
      'Check the sign-up page on a phone',
      'The sign-up page fits at 390 px, but the button sits under the keyboard.',
      'msg_rated04',
      'board',
    ],
    [
      'robin',
      'down',
      ['unsafe'],
      'It wanted to edit the whole stylesheet for one button.',
      codingAgent,
      94,
      'Fix this review comment in the project.',
      'I will rewrite styles.css to use the new tokens everywhere.',
      'msg_rated05',
      'comment-5',
    ],
    [
      'jo',
      'up',
      [],
      '',
      demoAgent,
      118,
      'Which pages have no phone capture?',
      'Every page has a phone capture except the app settings page.',
      'msg_rated06',
      'board',
    ],
    [
      'sam',
      'up',
      [],
      'Exactly the copy I needed.',
      demoAgent,
      140,
      'Suggest shorter hero copy',
      'Try: "Notes that keep up with you."',
      'msg_rated07',
      'board',
    ],
  ]
  return rows.map(([handle, rating, reasons, note, agent, hours, question, answer, messageId, threadId]) => ({
    boardId: EXPORT_BOARD,
    threadId,
    messageId,
    rater: `user:${user(handle)}`,
    raterName: USERS.find((item) => item.handle === handle).displayName,
    rating,
    reasons,
    note,
    agent,
    question,
    answer,
    answerStatus: 'done',
    createdAt: at(hours),
    updatedAt: at(hours),
  }))
}

// A first conversation on the board thread, so the chat panel shows what an
// answer with tool cards looks like before anyone types.
export function seedThread(now = Date.now()) {
  const at = (hours) => new Date(now - hours * HOUR).toISOString()
  return [
    { id: 'msg_seed1', role: 'user', text: 'What is still open on the pricing page?', attachments: [], createdAt: at(5) },
    {
      id: 'msg_seed2',
      role: 'assistant',
      text: 'Pricing has one open comment: Sam asks whether the plans can sit side by side on a tablet. The Plus button fix was resolved with pull request 42, and the yearly toggle variant has one open note from Robin about the "-17%" label. Want me to suggest a tablet layout or other wording?',
      cards: [
        {
          id: 'seed-tool-1',
          kind: 'tool',
          name: 'list_comments',
          label: 'Read the comments on Pricing',
          state: 'done',
          detail: '1 open, 1 resolved, 1 open on a variant',
        },
      ],
      model: 'scripted',
      status: 'done',
      createdAt: at(4.99),
    },
  ]
}
