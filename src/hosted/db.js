// The hosted database: one SQLite file (WAL), opened with node:sqlite.
//
// Why node:sqlite and not better-sqlite3: Shapewall is mostly a CLI that
// people run with npx, and a native addon would be downloaded and built for
// every one of them, hosted or not. node:sqlite ships with Node (22.13+ without
// a flag), has the same synchronous API shape, and the hosted server is one
// process on one host. The cost is an ExperimentalWarning on Node 22, which the
// hosted entry point filters (see quietSqliteWarning).
//
// Tenant tables carry workspace_id on every row. Only src/hosted/tenancy.js
// writes SQL against them (test/hosted-tenancy.test.js checks that).

import fs from 'node:fs'
import path from 'node:path'

export const MIN_NODE = [22, 13]

export function nodeSupportsSqlite(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

// Node 22 prints one ExperimentalWarning when node:sqlite loads. Other
// warnings still print.
export function quietSqliteWarning() {
  const original = process.emitWarning
  process.emitWarning = function emitWarning(warning, ...args) {
    const text = typeof warning === 'string' ? warning : warning?.message
    const type = typeof args[0] === 'string' ? args[0] : args[0]?.type
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(text))) return
    return original.call(process, warning, ...args)
  }
}

const MIGRATIONS = [
  // 1: accounts, workspaces, projects, comments, tokens, audit
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    webauthn_user_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    device_type TEXT,
    backed_up INTEGER NOT NULL DEFAULT 0,
    nickname TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    recovery_added_at TEXT
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);
  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT 'passkey' CHECK (via IN ('passkey', 'recovery'))
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE challenges (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    challenge TEXT NOT NULL,
    user_id TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    expires_at TEXT NOT NULL
  );
  CREATE TABLE setup_codes (
    code_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    CHECK (workspace_id = id)
  );
  CREATE TABLE memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX memberships_user ON memberships(user_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT,
    revoked_at TEXT
  );
  CREATE INDEX invites_workspace ON invites(workspace_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, slug)
  );
  CREATE TABLE boards (
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    definition TEXT NOT NULL,
    next_comment INTEGER NOT NULL DEFAULT 1,
    pushed_at TEXT,
    push_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, board_id)
  );
  CREATE INDEX boards_workspace ON boards(workspace_id);
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    viewport TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    author_handle TEXT,
    author_user_id TEXT,
    author_token_id TEXT,
    anchor TEXT,
    capture_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    resolution TEXT,
    fix_ref TEXT,
    replies TEXT NOT NULL DEFAULT '[]',
    agent_status TEXT,
    agent_status_at TEXT,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    reopened_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (project_id, board_id, number)
  );
  CREATE INDEX comments_workspace ON comments(workspace_id, project_id, board_id);
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX api_tokens_workspace ON api_tokens(workspace_id, project_id);
  CREATE TABLE pushes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    token_id TEXT,
    definition TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'failed')),
    files INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX pushes_workspace ON pushes(workspace_id, project_id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT,
    user_id TEXT,
    token_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL
  );
  CREATE INDEX audit_workspace ON audit_log(workspace_id, id);
  `,
  // 2: user management. Share links (view or guest-comment links to one
  // project), the workspace switch for them, last activity per membership,
  // invite expiry choice and email, session ids and devices for the Account
  // page, and guest authorship on comments.
  `
  ALTER TABLE workspaces ADD COLUMN share_links INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memberships ADD COLUMN last_active_at TEXT;
  ALTER TABLE invites ADD COLUMN email TEXT;
  ALTER TABLE invites ADD COLUMN emailed_at TEXT;
  ALTER TABLE sessions ADD COLUMN id TEXT;
  ALTER TABLE sessions ADD COLUMN user_agent TEXT;
  ALTER TABLE sessions ADD COLUMN ip TEXT;
  UPDATE sessions SET id = 'se_' || lower(hex(randomblob(12))) WHERE id IS NULL;
  CREATE UNIQUE INDEX sessions_id ON sessions(id);
  ALTER TABLE comments ADD COLUMN author_share_id TEXT;
  ALTER TABLE audit_log ADD COLUMN share_id TEXT;
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('view', 'comment')),
    passcode_hash TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    opens INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX shares_workspace ON shares(workspace_id, project_id);
  `,
  // 3: emoji reactions on comments (replies keep theirs in the replies JSON)
  // and when a comment's text was last edited.
  `
  ALTER TABLE comments ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE comments ADD COLUMN edited_at TEXT;
  `,
  // 4: a note on invites ("for Sam, design"), shown in the pending list, and
  // when the account's owner last saw the security notice (a recovery code
  // was used), so it shows once on the next sign-in.
  `
  ALTER TABLE invites ADD COLUMN note TEXT;
  ALTER TABLE users ADD COLUMN security_seen_at TEXT;
  `,
  // 5: hosted access (W6). Pending "shapewall login"s in the database (they
  // survive a restart; the approved token is sealed to the CLI's device code),
  // one row per share link guest (so one guest can be ended), public projects
  // (a workspace switch and a public id per project), the RP ID each passkey
  // was made for and the admin idle clock per session (for moving a server to
  // a new origin and for the 12-hour admin idle expiry), rebind tokens for a
  // move, and a small key/value table for server state (origin, moves).
  `
  CREATE TABLE device_logins (
    device_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ip TEXT,
    seal_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    result TEXT
  );
  CREATE INDEX device_logins_expiry ON device_logins(expires_at);
  CREATE TABLE guest_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    ip_prefix TEXT,
    device TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ended_at TEXT,
    ended_by TEXT
  );
  CREATE INDEX guest_sessions_share ON guest_sessions(workspace_id, share_id);
  ALTER TABLE workspaces ADD COLUMN public_projects INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN public_id TEXT;
  ALTER TABLE projects ADD COLUMN public_at TEXT;
  ALTER TABLE projects ADD COLUMN public_by TEXT;
  CREATE UNIQUE INDEX projects_public_id ON projects(public_id);
  ALTER TABLE passkeys ADD COLUMN rp_id TEXT;
  ALTER TABLE sessions ADD COLUMN admin_seen_at TEXT;
  CREATE TABLE rebind_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_origin TEXT NOT NULL,
    to_origin TEXT NOT NULL,
    fresh INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX rebind_tokens_user ON rebind_tokens(user_id);
  CREATE TABLE server_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 6: scoped dispatch, project budgets, and command approvals. Existing
  // comments intentionally start unvouched.
  `
  ALTER TABLE projects ADD COLUMN agent_policy TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE comments ADD COLUMN dispatch_hash TEXT;
  ALTER TABLE comments ADD COLUMN dispatch_by TEXT;
  ALTER TABLE comments ADD COLUMN dispatch_at TEXT;
  ALTER TABLE comments ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE comments ADD COLUMN run_approved INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE agent_claims (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    comment_number INTEGER NOT NULL,
    token_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX agent_claims_project ON agent_claims(workspace_id, project_id, created_at);
  CREATE TABLE agent_approvals (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    comment_number INTEGER NOT NULL,
    token_id TEXT NOT NULL,
    comment_hash TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    command TEXT NOT NULL,
    command_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    answered_by TEXT,
    answered_at TEXT
  );
  `,
  // 7: operator tools. A workspace suspended by the server operator
  // (read-only, share links off, tokens refused; the reason is shown to its
  // admins), a per-workspace retention setting (how many older versions per
  // page and viewport to keep; NULL = the server default), the operator log
  // (every `shapewall hosted admin` action, kept when a workspace is deleted)
  // and abuse reports from the public report form.
  `
  ALTER TABLE workspaces ADD COLUMN suspended_at TEXT;
  ALTER TABLE workspaces ADD COLUMN suspended_reason TEXT;
  ALTER TABLE workspaces ADD COLUMN retention_versions INTEGER;
  CREATE TABLE operator_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL
  );
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('copyright', 'personal_data', 'malware_phishing', 'illegal', 'other')),
    details TEXT NOT NULL DEFAULT '',
    contact TEXT,
    target_workspace TEXT,
    ip_hash TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    closed_note TEXT
  );
  CREATE INDEX reports_open ON reports(closed_at, created_at);
  `,
  // 8: one-way local imports, scoped idempotency and conflict snapshots.
  `
  ALTER TABLE device_logins ADD COLUMN purpose TEXT;
  ALTER TABLE comments ADD COLUMN import_author_kind TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE comments ADD COLUMN imported_by TEXT;
  ALTER TABLE comments ADD COLUMN imported_at TEXT;
  ALTER TABLE comments ADD COLUMN import_orphan INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE comments ADD COLUMN imported_reactions TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE import_sessions (
    workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    token_id TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT,
    PRIMARY KEY(workspace_id, project_id, session_id),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE TABLE import_batches (
    workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    batch_key TEXT NOT NULL, token_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(workspace_id, project_id, session_id, batch_key),
    FOREIGN KEY(workspace_id, project_id, session_id) REFERENCES import_sessions(workspace_id, project_id, session_id) ON DELETE CASCADE
  );
  CREATE TABLE comment_imports (
    workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, board_id TEXT NOT NULL,
    import_key TEXT NOT NULL, comment_number INTEGER NOT NULL, source_hash TEXT NOT NULL,
    remote_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, project_id, board_id, import_key),
    FOREIGN KEY(project_id, board_id) REFERENCES boards(project_id, board_id) ON DELETE CASCADE
  );
  `,
  // 9: canonical, bounded profile images, independent of workspace data.
  `
  CREATE TABLE user_avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    png BLOB NOT NULL CHECK(length(png) <= 524288),
    digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 10: reports are private unless the creator explicitly includes them in a link.
  `ALTER TABLE shares ADD COLUMN include_checks INTEGER NOT NULL DEFAULT 0 CHECK(include_checks IN (0, 1));`,
  // 11: images and drawings on comments and replies. The image records and
  // the drawing are JSON on the comment row (replies keep theirs in the
  // replies JSON); the image bytes are BLOBs here, not in the board folder,
  // which every push replaces. A row belongs to one comment (and reply) and
  // goes with it; rows without a comment are images a `shapewall share`
  // import uploaded first (import_session, import_ref) and attaches in a
  // later batch, swept when never attached.
  `
  ALTER TABLE comments ADD COLUMN images TEXT;
  ALTER TABLE comments ADD COLUMN drawing TEXT;
  CREATE TABLE comment_files (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    file TEXT NOT NULL,
    comment_number INTEGER,
    reply_id INTEGER,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    data BLOB NOT NULL CHECK (length(data) <= 10485760),
    import_session TEXT,
    import_ref TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, board_id, file),
    FOREIGN KEY (project_id, board_id, comment_number) REFERENCES comments(project_id, board_id, number) ON DELETE CASCADE
  );
  CREATE INDEX comment_files_comment ON comment_files(workspace_id, project_id, board_id, comment_number);
  CREATE INDEX comment_files_import ON comment_files(workspace_id, project_id, import_session, import_ref);
  `,
  // 12: agents (0.4.0). A project API token that may take work (the claim
  // scope) is an agent: this row gives it a face (kind, icon, tint, machine),
  // an audience (who may send it work), an approval rule and who may change
  // or answer it. The name stays the token's. A project has a default
  // agent; a comment can be addressed to one agent (NULL: any agent); a
  // claim remembers which agent took it. agent_runs is the usage record of
  // each comment an agent took (who asked, which agent, when, how it ended;
  // never comment or answer text), shaped for the usage dashboard, whose
  // token and cost columns stay NULL until an agent reports them.
  //
  // Every token that already has the claim scope becomes an agent of kind
  // "watcher" with the audience it had in effect before: everyone the
  // project's agent policy trusts (audience_inherited marks that it was
  // never chosen). Agents made from now on start with "owner".
  `
  CREATE TABLE agents (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL UNIQUE REFERENCES api_tokens(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'watcher',
    icon TEXT,
    tint TEXT,
    machine TEXT,
    capabilities TEXT NOT NULL DEFAULT '{}',
    audience TEXT NOT NULL DEFAULT 'owner' CHECK (audience IN ('owner', 'members', 'trusted')),
    audience_users TEXT NOT NULL DEFAULT '[]',
    audience_inherited INTEGER NOT NULL DEFAULT 0,
    approval_rule TEXT NOT NULL DEFAULT 'ask' CHECK (approval_rule IN ('ask', 'auto')),
    approval_change_role TEXT NOT NULL DEFAULT 'admin' CHECK (approval_change_role IN ('admin', 'owner')),
    approval_answer_role TEXT NOT NULL DEFAULT 'admin' CHECK (approval_answer_role IN ('admin', 'owner')),
    created_by TEXT,
    created_at TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    last_seen_at TEXT
  );
  CREATE INDEX agents_project ON agents(workspace_id, project_id);
  ALTER TABLE projects ADD COLUMN default_agent_id TEXT;
  ALTER TABLE comments ADD COLUMN agent_id TEXT;
  ALTER TABLE agent_claims ADD COLUMN agent_id TEXT;
  INSERT INTO agents (workspace_id, project_id, id, token_id, kind, audience, audience_inherited, created_by, created_at,
    approved_by, approved_at, last_seen_at)
  SELECT workspace_id, project_id, 'ag_' || lower(hex(randomblob(12))), id, 'watcher', 'trusted', 1, created_by, created_at,
    created_by, created_at, last_used_at
  FROM api_tokens WHERE scopes LIKE '%"claim"%';
  UPDATE agent_claims SET agent_id = (SELECT a.id FROM agents a WHERE a.token_id = agent_claims.token_id);
  CREATE TABLE agent_runs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'fix',
    agent_id TEXT,
    claim_id TEXT,
    board_id TEXT,
    comment_number INTEGER,
    thread_id TEXT,
    asked_by TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT,
    model TEXT,
    effort TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    cost_micros INTEGER,
    steps INTEGER
  );
  CREATE INDEX agent_runs_time ON agent_runs(workspace_id, started_at);
  CREATE INDEX agent_runs_project ON agent_runs(workspace_id, project_id, started_at);
  CREATE INDEX agent_runs_agent ON agent_runs(workspace_id, agent_id, started_at);
  CREATE INDEX agent_runs_person ON agent_runs(workspace_id, asked_by, started_at);
  CREATE INDEX agent_runs_claim ON agent_runs(workspace_id, claim_id);
  `,
  // 13: connected agents and chat (0.5.0). `shapewall agent connect` holds a
  // link to the server and members chat with the agent on the board. A
  // thread belongs to a board ("board" and "comment-<n>" are shared, a
  // "chat-..." is its starter's own) and names the agent it talks to. Its
  // messages are stored here (the person's text, the agent's answer with its
  // cards in their final state); a turn is one question on its way through
  // an agent, whose live events stay in memory. A device login remembers
  // what the machine said it runs (meta), for the approval page.
  `
  ALTER TABLE device_logins ADD COLUMN meta TEXT;
  CREATE TABLE chat_threads (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    agent_id TEXT,
    owner_user_id TEXT,
    title TEXT,
    title_source TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, project_id, board_id, thread_id)
  );
  CREATE TABLE chat_messages (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    author_user_id TEXT,
    agent_id TEXT,
    turn_id TEXT,
    body TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX chat_messages_thread ON chat_messages(workspace_id, project_id, board_id, thread_id, created_at);
  CREATE TABLE chat_turns (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    state TEXT NOT NULL DEFAULT 'queued',
    acked_seq INTEGER NOT NULL DEFAULT 0,
    started_by TEXT,
    user_message_id TEXT,
    run_id TEXT,
    comment_number INTEGER,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX chat_turns_thread ON chat_turns(workspace_id, project_id, board_id, thread_id, created_at);
  CREATE INDEX chat_turns_agent ON chat_turns(workspace_id, agent_id, state);
  `,
  // 14: approvals and edits from a hosted board (0.6.0). chat_permissions is
  // one row per permission card a connected agent asked during a fix: what
  // it asked (the card, as hashed), its state, who answered and when. The
  // usage record of a run gains how many requests it asked and how they
  // ended. Additive; an older build ignores all of it.
  `
  CREATE TABLE chat_permissions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    card TEXT NOT NULL,
    card_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    answered_by TEXT,
    answered_at TEXT,
    PRIMARY KEY (workspace_id, turn_id, id)
  );
  CREATE INDEX chat_permissions_board ON chat_permissions(workspace_id, project_id, board_id, state);
  ALTER TABLE agent_runs ADD COLUMN approvals_asked INTEGER;
  ALTER TABLE agent_runs ADD COLUMN approvals_allowed INTEGER;
  ALTER TABLE agent_runs ADD COLUMN approvals_denied INTEGER;
  `,
]

export async function openDatabase(file) {
  const { DatabaseSync } = await import('node:sqlite')
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  migrate(db)
  return db
}

// A ledger allows reserved workstreams to land out of order. user_version is
// still the highest applied number, but an absent reserved migration is never
// marked applied. Legacy databases (before the ledger) have contiguous 1..4.
export function migrate(db, migrations = MIGRATIONS) {
  transaction(db, () => {
    const hadLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    const current = db.prepare('PRAGMA user_version').get().user_version
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
    if (!hadLedger) {
      if (current > 4)
        throw new Error('Database has untracked migrations newer than version 4; restore its pre-upgrade backup before continuing.')
      for (let version = 1; version <= current; version += 1) db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(version)
    }
    for (let index = 0; index < migrations.length; index += 1) {
      if (!migrations[index] || db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(index + 1)) continue
      db.exec(migrations[index])
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(index + 1)
    }
    const highest = db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM schema_migrations').get().n
    db.exec(`PRAGMA user_version = ${highest}`)
  })
}

// Runs fn() inside BEGIN IMMEDIATE ... COMMIT (nested calls join the outer
// transaction). fn must be synchronous.
const inTransaction = new WeakSet()
export function transaction(db, fn) {
  if (inTransaction.has(db)) return fn()
  db.exec('BEGIN IMMEDIATE')
  inTransaction.add(db)
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw error
  } finally {
    inTransaction.delete(db)
  }
}

// Schema feature checks stay beside migrations; tenant modules never use the raw handle.
export function hasCommentPolicy(db) {
  return db
    .prepare('PRAGMA table_info(comments)')
    .all()
    .some((column) => column.name === 'imported')
}
