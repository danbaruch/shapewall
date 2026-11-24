-- The sessions table as 0.8.x makes it (migrations 1 to 17), frozen: the literal CREATE statements from
-- sqlite_master of a new database opened by origin/staging at 2d97152 (0.8.0). No data. Migration 18 is tested
-- from this (test/hosted-session-via.test.js); do not edit it to match a later schema.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT 'passkey' CHECK (via IN ('passkey', 'recovery'))
  , id TEXT, user_agent TEXT, ip TEXT, admin_seen_at TEXT, tailnet_login TEXT);
CREATE UNIQUE INDEX sessions_id ON sessions(id);
CREATE INDEX sessions_user ON sessions(user_id);
