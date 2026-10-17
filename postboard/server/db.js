import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Member', color TEXT NOT NULL, password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, scheduled_at INTEGER, data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL,
  post_id TEXT, link TEXT, at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, at);
CREATE TABLE IF NOT EXISTS workspace (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  platform TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, handle TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', followers INTEGER NOT NULL DEFAULT 0,
  external_id TEXT, secrets TEXT, expires_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT, user_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_channels (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, dm_key TEXT UNIQUE, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages(channel_id, at);
CREATE TABLE IF NOT EXISTS dm_threads (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, contact_id TEXT,
  contact_name TEXT NOT NULL DEFAULT '', contact_handle TEXT NOT NULL DEFAULT '', contact_avatar TEXT,
  last_at INTEGER NOT NULL, last_inbound_at INTEGER, last_text TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', assigned_to TEXT,
  sandbox INTEGER NOT NULL DEFAULT 0, UNIQUE (platform, external_id)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  external_id TEXT, direction TEXT NOT NULL, body TEXT NOT NULL, sent_by TEXT, at INTEGER NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'received', error TEXT, UNIQUE (thread_id, external_id)
);
CREATE INDEX IF NOT EXISTS dm_messages_thread ON dm_messages(thread_id, at);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
