import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATH = "/app/data/msoauth2api.db";

function resolveDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return configured;
  // Outside the container /app/data does not exist, so fall back to ./data for local dev.
  return fs.existsSync("/app/data")
    ? DEFAULT_PATH
    : path.resolve(process.cwd(), "data/msoauth2api.db");
}

const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);

// WAL so a long IMAP-backed request cannot block a write, and foreign keys because
// SQLite leaves them off by default.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    email              TEXT NOT NULL UNIQUE,
    password           TEXT,
    client_id          TEXT NOT NULL,
    refresh_token      TEXT NOT NULL,
    -- "auto" (Graph, falling back to IMAP) or "imap" for tokens consented only to the
    -- older Outlook IMAP permission.
    auth_type          TEXT NOT NULL DEFAULT 'auto',
    -- Handed out ahead of lower numbers by the pool. 0 is the ordinary case; negatives sit
    -- at the back without being disabled.
    priority           INTEGER NOT NULL DEFAULT 0,
    remark             TEXT,
    disabled           INTEGER NOT NULL DEFAULT 0,
    -- Why it is disabled: 'abuse', 'invalidGrant', 'manual', or NULL when nothing recorded one.
    block_reason       TEXT,
    last_refresh_at    INTEGER,
    last_refresh_error TEXT,
    last_copied_at     INTEGER,
    last_used_at       INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    last_used_at INTEGER,
    created_at   INTEGER NOT NULL
  );

  -- Optional configuration for a type. A type works without a row here; this only tells the
  -- server how to recognise that service's mail and pull the code out of it.
  CREATE TABLE IF NOT EXISTS usage_types (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    label          TEXT,
    from_filter    TEXT,
    subject_filter TEXT,
    code_pattern   TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  -- One row per address per integration type ("telegram", "discord"). A row that is leased
  -- but not confirmed expires; a confirmed row retires that address for that type.
  CREATE TABLE IF NOT EXISTS account_usages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    type             TEXT NOT NULL,
    leased_at        INTEGER NOT NULL,
    lease_expires_at INTEGER,
    confirmed_at     INTEGER,
    code             TEXT,
    code_at          INTEGER,
    UNIQUE(account_id, type)
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
  CREATE INDEX IF NOT EXISTS idx_usages_type ON account_usages(type, confirmed_at, lease_expires_at);
  CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
`);

/**
 * SQLite has no ADD COLUMN IF NOT EXISTS, and the CREATE TABLE above only applies to a
 * fresh file, so columns added after a release need this to reach existing installs.
 */
function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn("accounts", "last_copied_at", "INTEGER");
addColumn("accounts", "last_used_at", "INTEGER");
// Existing rows predate the split and were all on the Graph-first path, which is what the
// default describes, so no backfill is needed.
addColumn("accounts", "auth_type", "TEXT NOT NULL DEFAULT 'auto'");
addColumn("accounts", "priority", "INTEGER NOT NULL DEFAULT 0");
// Nullable with no backfill: rows disabled before this existed were switched off by hand,
// and guessing a reason for them would be worse than leaving it blank.
addColumn("accounts", "block_reason", "TEXT");

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function dbFilePath(): string {
  return dbPath;
}
