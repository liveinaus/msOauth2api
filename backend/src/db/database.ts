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
    remark             TEXT,
    disabled           INTEGER NOT NULL DEFAULT 0,
    last_refresh_at    INTEGER,
    last_refresh_error TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
  CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
`);

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
