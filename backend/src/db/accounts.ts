import { db } from "./database";
import { decryptSecret, encryptSecret, encryptionEnabled, isEncrypted } from "./crypto";
import type { Account } from "../types";

type AccountRow = {
  id: number;
  email: string;
  password: string | null;
  client_id: string;
  refresh_token: string;
  remark: string | null;
  disabled: number;
  last_refresh_at: number | null;
  last_refresh_error: string | null;
  created_at: number;
  updated_at: number;
};

export type AccountInput = {
  email: string;
  password?: string | null;
  clientId: string;
  refreshToken: string;
  remark?: string | null;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    password: row.password === null ? null : decryptSecret(row.password),
    clientId: row.client_id,
    refreshToken: decryptSecret(row.refresh_token),
    remark: row.remark,
    disabled: row.disabled === 1,
    lastRefreshAt: row.last_refresh_at,
    lastRefreshError: row.last_refresh_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(): Account[] {
  const rows = db.prepare("SELECT * FROM accounts ORDER BY id ASC").all() as AccountRow[];
  return rows.map(toAccount);
}

export function getAccount(id: number): Account | undefined {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  return row ? toAccount(row) : undefined;
}

export function getAccountByEmail(email: string): Account | undefined {
  const row = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as
    AccountRow | undefined;
  return row ? toAccount(row) : undefined;
}

/**
 * Inserts, or updates the credentials of an existing row with the same address. Import
 * files routinely carry an address that is already on the panel with a newer token, and
 * upstream's importer simply appended a duplicate.
 */
export function upsertAccount(input: AccountInput): Account {
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (email, password, client_id, refresh_token, remark, created_at, updated_at)
     VALUES (@email, @password, @clientId, @refreshToken, @remark, @now, @now)
     ON CONFLICT(email) DO UPDATE SET
       password      = excluded.password,
       client_id     = excluded.client_id,
       refresh_token = excluded.refresh_token,
       remark        = COALESCE(excluded.remark, accounts.remark),
       updated_at    = excluded.updated_at`,
  ).run({
    email: input.email,
    password: input.password ? encryptSecret(input.password) : null,
    clientId: input.clientId,
    refreshToken: encryptSecret(input.refreshToken),
    remark: input.remark ?? null,
    now,
  });

  // Non-null: the statement above either inserted this address or updated it.
  return getAccountByEmail(input.email)!;
}

export function updateAccount(
  id: number,
  patch: Partial<AccountInput> & { disabled?: boolean },
): Account | undefined {
  const existing = getAccount(id);
  if (!existing) return undefined;

  db.prepare(
    `UPDATE accounts SET
       email         = @email,
       password      = @password,
       client_id     = @clientId,
       refresh_token = @refreshToken,
       remark        = @remark,
       disabled      = @disabled,
       updated_at    = @now
     WHERE id = @id`,
  ).run({
    id,
    email: patch.email ?? existing.email,
    password: (() => {
      const next = patch.password === undefined ? existing.password : patch.password;
      return next ? encryptSecret(next) : null;
    })(),
    clientId: patch.clientId ?? existing.clientId,
    refreshToken: encryptSecret(patch.refreshToken ?? existing.refreshToken),
    remark: patch.remark === undefined ? existing.remark : patch.remark,
    disabled: (patch.disabled ?? existing.disabled) ? 1 : 0,
    now: Date.now(),
  });

  return getAccount(id);
}

/** Records the outcome of a token refresh so the UI can show which accounts have gone stale. */
export function recordRefresh(id: number, refreshToken: string | null, error: string | null): void {
  db.prepare(
    `UPDATE accounts SET
       refresh_token      = COALESCE(@refreshToken, refresh_token),
       last_refresh_at    = @now,
       last_refresh_error = @error,
       updated_at         = @now
     WHERE id = @id`,
  ).run({
    id,
    refreshToken: refreshToken ? encryptSecret(refreshToken) : null,
    error,
    now: Date.now(),
  });
}

export function deleteAccounts(ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`).run(...ids);
  return result.changes;
}

/**
 * Encrypts any secret still sitting in the database as plain text. Called once at boot so
 * setting MSAPI_DATA_KEY takes effect on rows saved before it existed.
 *
 * Only untagged values are touched. Comparing ciphertext would be no use as a test, since
 * every encryption draws a fresh IV and so never matches what is already stored -- that
 * would rewrite every row on every boot.
 */
export function reencryptAll(): number {
  if (!encryptionEnabled()) return 0;

  const rows = db.prepare("SELECT * FROM accounts").all() as AccountRow[];
  const update = db.prepare("UPDATE accounts SET password = ?, refresh_token = ? WHERE id = ?");

  let changed = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      const passwordPlain = row.password !== null && !isEncrypted(row.password);
      const tokenPlain = !isEncrypted(row.refresh_token);
      if (!passwordPlain && !tokenPlain) continue;

      update.run(
        row.password === null ? null : passwordPlain ? encryptSecret(row.password) : row.password,
        tokenPlain ? encryptSecret(row.refresh_token) : row.refresh_token,
        row.id,
      );
      changed++;
    }
  });
  run();
  return changed;
}
