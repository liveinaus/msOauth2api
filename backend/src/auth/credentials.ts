import argon2 from "argon2";
import crypto from "node:crypto";
import { db, getSetting, setSetting } from "../db/database";

const USERNAME_KEY = "admin_username";
const PASSWORD_HASH_KEY = "admin_password_hash";
const BOOTSTRAP_PASSWORD_KEY = "admin_password_bootstrap";

/**
 * Credentials live in the database, not in the environment: the operator has to be able to
 * change them from Settings, and an env var they cannot edit at runtime would be
 * reasserted on every restart. ADMIN_USERNAME/ADMIN_PASSWORD therefore seed the row once
 * and are ignored afterwards.
 */
export async function initCredentials(): Promise<void> {
  const envUsername = process.env.ADMIN_USERNAME?.trim() || "admin";
  const envPassword = process.env.ADMIN_PASSWORD ?? "changeme";

  if (!getSetting(PASSWORD_HASH_KEY)) {
    setSetting(USERNAME_KEY, envUsername);
    setSetting(PASSWORD_HASH_KEY, await argon2.hash(envPassword));
    // Remember that this password came from the environment default so the UI can insist
    // on a real one at first login.
    setSetting(BOOTSTRAP_PASSWORD_KEY, envPassword === "changeme" ? "1" : "0");
    console.log(`[auth] seeded admin account "${envUsername}"`);
  }
}

export function adminUsername(): string {
  return getSetting(USERNAME_KEY) ?? "admin";
}

/** True while the admin password is still the shipped default. */
export function usingDefaultPassword(): boolean {
  return getSetting(BOOTSTRAP_PASSWORD_KEY) === "1";
}

export async function verifyAdmin(username: string, password: string): Promise<boolean> {
  const hash = getSetting(PASSWORD_HASH_KEY);
  if (!hash) return false;

  // Compare the username in constant time too, so a wrong name and a wrong password are
  // not distinguishable by how long the request took.
  const expected = Buffer.from(adminUsername());
  const supplied = Buffer.from(username);
  const nameOk = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);

  const passwordOk = await argon2.verify(hash, password).catch(() => false);
  return nameOk && passwordOk;
}

export async function setAdminPassword(password: string): Promise<void> {
  setSetting(PASSWORD_HASH_KEY, await argon2.hash(password));
  setSetting(BOOTSTRAP_PASSWORD_KEY, "0");
  bumpTokenEpoch();
}

export function setAdminUsername(username: string): void {
  setSetting(USERNAME_KEY, username);
  bumpTokenEpoch();
}

// ── Token revocation ──────────────────────────────────────────────────────────

const TOKEN_EPOCH_KEY = "token_epoch";

/**
 * A signed token cannot be withdrawn, so revocation needs a value the server can move:
 * every session token carries the epoch it was issued under, and changing credentials
 * advances it, retiring every token behind it at once. Without this a stolen token would
 * outlive a password change by its full lifetime.
 */
export function getTokenEpoch(): number {
  return Number(getSetting(TOKEN_EPOCH_KEY)) || 0;
}

export function bumpTokenEpoch(): number {
  // Date.now() alone can repeat within a millisecond, which would leave a token signed in
  // the same tick still valid; stepping past the stored value guarantees it moves.
  const next = Math.max(Date.now(), getTokenEpoch() + 1);
  setSetting(TOKEN_EPOCH_KEY, String(next));
  return next;
}

// ── API keys ──────────────────────────────────────────────────────────────────

export type ApiKeyRecord = {
  id: number;
  name: string;
  keyPrefix: string;
  lastUsedAt: number | null;
  createdAt: number;
};

type ApiKeyRow = {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used_at: number | null;
  created_at: number;
};

/** The plain key is returned once, at creation, and only its hash is kept. */
export async function createApiKey(name: string): Promise<{ record: ApiKeyRecord; key: string }> {
  const key = `msk_${crypto.randomBytes(24).toString("base64url")}`;
  const prefix = key.slice(0, 12);
  const now = Date.now();

  const result = db
    .prepare("INSERT INTO api_keys (name, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?)")
    .run(name, await argon2.hash(key), prefix, now);

  return {
    key,
    record: {
      id: Number(result.lastInsertRowid),
      name,
      keyPrefix: prefix,
      lastUsedAt: null,
      createdAt: now,
    },
  };
}

export function listApiKeys(): ApiKeyRecord[] {
  const rows = db.prepare("SELECT * FROM api_keys ORDER BY id ASC").all() as ApiKeyRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }));
}

export function deleteApiKey(id: number): boolean {
  return db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
}

/**
 * Checks a presented key against the stored hashes.
 *
 * Argon2 is deliberately slow, so the prefix column narrows the candidates first and only
 * those are verified. The prefix is not a secret and cannot be used to authenticate on its
 * own; it exists so a request costs one hash rather than one per key on the panel.
 */
export async function verifyApiKey(presented: string): Promise<boolean> {
  const prefix = presented.slice(0, 12);
  const rows = db.prepare("SELECT * FROM api_keys WHERE key_prefix = ?").all(prefix) as ApiKeyRow[];

  for (const row of rows) {
    if (await argon2.verify(row.key_hash, presented).catch(() => false)) {
      db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
      return true;
    }
  }
  return false;
}
