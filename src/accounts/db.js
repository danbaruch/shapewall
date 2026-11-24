import { openSqlite, prepareSql, transaction } from '../shared/sqlite.js'

// The local account tables have had these columns since the first local
// account release. Later sidecars contain extra hosted tables and columns.
// Leave their rows, constraints and migration ledger in place.
const ACCOUNT_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    webauthn_user_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    security_seen_at TEXT
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
    recovery_added_at TEXT,
    rp_id TEXT
  );
  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT 'passkey' CHECK (via IN ('passkey', 'recovery')),
    id TEXT,
    user_agent TEXT,
    ip TEXT,
    admin_seen_at TEXT
  );
  CREATE TABLE challenges (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    challenge TEXT NOT NULL,
    user_id TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    expires_at TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT,
    user_id TEXT,
    token_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL,
    share_id TEXT
  );
  CREATE TABLE user_avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    png BLOB NOT NULL CHECK(length(png) <= 524288),
    digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX audit_workspace ON audit_log(workspace_id, id);
  CREATE UNIQUE INDEX sessions_id ON sessions(id);
`

export function openAccountDatabase(file) {
  return openSqlite(file, (db) => {
    transaction(db, () => {
      const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'users'").get()
      if (!existing) db.exec(ACCOUNT_SCHEMA)
    })
  })
}

const TABLES = new Set(['users', 'sessions', 'passkeys', 'recovery_codes', 'challenges', 'user_avatars'])

// Shared credential queries may only address account records. The ON CONFLICT
// clause of an avatar upsert contains DO UPDATE SET, with no table name.
export function accountQueries(db) {
  function statement(sql) {
    for (const [, table] of sql.matchAll(/\b(?:FROM|JOIN|INTO|(?<!DO )UPDATE)\s+([a-z_]+)/gi)) {
      if (!TABLES.has(table.toLowerCase())) throw new Error(`Unexpected account table: ${table}`)
    }
    return prepareSql(db, sql)
  }
  return {
    get: (sql, params) => statement(sql).get(params),
    all: (sql, params) => statement(sql).all(params),
    run: (sql, params) => statement(sql).run(params),
  }
}
