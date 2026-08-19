import { db } from "./database";
import { decryptSecret, encryptSecret, encryptionEnabled, isEncrypted } from "./crypto";
import { parseAuthType, type Account, type AuthType } from "../types";

type AccountRow = {
  id: number;
  email: string;
  password: string | null;
  client_id: string;
  refresh_token: string;
  auth_type: string | null;
  remark: string | null;
  disabled: number;
  last_refresh_at: number | null;
  last_refresh_error: string | null;
  last_copied_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

export type AccountInput = {
  email: string;
  password?: string | null;
  clientId: string;
  refreshToken: string;
  authType?: AuthType;
  remark?: string | null;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    password: row.password === null ? null : decryptSecret(row.password),
    clientId: row.client_id,
    refreshToken: decryptSecret(row.refresh_token),
    // An unrecognised value is treated as "auto" rather than failing the read: a row hand-
    // edited in the database should not take the whole account list down.
    authType: parseAuthType(row.auth_type) ?? "auto",
    remark: row.remark,
    disabled: row.disabled === 1,
    lastRefreshAt: row.last_refresh_at,
    lastRefreshError: row.last_refresh_error,
    lastCopiedAt: row.last_copied_at,
    lastUsedAt: row.last_used_at,
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
 *
 * The known-address case is an UPDATE rather than an upsert because AUTOINCREMENT consumes
 * an id even when the insert loses to ON CONFLICT: re-importing a 500-line file would step
 * the counter 500 places, and that counter is the number the panel shows against each
 * address. The insert below keeps its ON CONFLICT clause anyway, so if a row appears
 * between the lookup and the write the result is still a correct update.
 */
export function upsertAccount(input: AccountInput): Account {
  const now = Date.now();
  const existing = getAccountByEmail(input.email);

  if (existing) {
    db.prepare(
      `UPDATE accounts SET
         password      = @password,
         client_id     = @clientId,
         refresh_token = @refreshToken,
         auth_type     = COALESCE(@authType, auth_type),
         remark        = COALESCE(@remark, remark),
         updated_at    = @now
       WHERE id = @id`,
    ).run({
      id: existing.id,
      password: input.password ? encryptSecret(input.password) : null,
      clientId: input.clientId,
      refreshToken: encryptSecret(input.refreshToken),
      // Like remark: an import that says nothing about the auth type leaves the one already
      // set alone, so re-importing a plain four-field file cannot silently un-mark an
      // account as IMAP-only.
      authType: input.authType ?? null,
      remark: input.remark ?? null,
      now,
    });
    // Non-null: the row was just read and updated by id.
    return getAccount(existing.id)!;
  }

  db.prepare(
    `INSERT INTO accounts (email, password, client_id, refresh_token, auth_type, remark, created_at, updated_at)
     VALUES (@email, @password, @clientId, @refreshToken, COALESCE(@authType, 'auto'), @remark, @now, @now)
     ON CONFLICT(email) DO UPDATE SET
       password      = excluded.password,
       client_id     = excluded.client_id,
       refresh_token = excluded.refresh_token,
       auth_type     = COALESCE(@authType, accounts.auth_type),
       remark        = COALESCE(excluded.remark, accounts.remark),
       updated_at    = excluded.updated_at`,
  ).run({
    email: input.email,
    password: input.password ? encryptSecret(input.password) : null,
    clientId: input.clientId,
    refreshToken: encryptSecret(input.refreshToken),
    authType: input.authType ?? null,
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
       auth_type     = @authType,
       remark        = @remark,
       disabled      = @disabled,
       updated_at    = @now
     WHERE id = @id`,
  ).run({
    id,
    email: patch.email ?? existing.email,
    authType: patch.authType ?? existing.authType,
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

/**
 * Clears a recorded fault after the mailbox has answered.
 *
 * Reading mail is better proof that an account works than a token refresh is, and without
 * this a fault recorded during a bad minute outlives it: the badge stays on the row and,
 * because the pool skips any account carrying one, the address never comes back into
 * circulation. `last_refresh_at` is left alone, since nothing was refreshed.
 */
export function clearRefreshError(id: number): void {
  db.prepare(
    `UPDATE accounts SET last_refresh_error = NULL, updated_at = @now
     WHERE id = @id AND last_refresh_error IS NOT NULL`,
  ).run({ id, now: Date.now() });
}

/**
 * Stamps the moment the address was copied out of the panel.
 *
 * Copying is the point an address gets handed to some other service, so it is the start of
 * the window that decides whether the account was actually used -- see recordUsage.
 * updated_at is deliberately left alone: nothing about the account itself changed.
 */
export function markCopied(id: number): Account | undefined {
  db.prepare("UPDATE accounts SET last_copied_at = ? WHERE id = ?").run(Date.now(), id);
  return getAccount(id);
}

/** Records the arrival of the newest message that landed after the address was copied. */
export function recordUsage(id: number, usedAt: number): void {
  db.prepare("UPDATE accounts SET last_used_at = ? WHERE id = ?").run(usedAt, id);
}

/**
 * Sets the auth type on a set of accounts at once.
 *
 * A batch bought or generated together is usually all on the same grant, so marking them
 * one at a time is the difference between a click and a hundred.
 */
export function setAuthType(ids: number[], authType: AuthType): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(`UPDATE accounts SET auth_type = ?, updated_at = ? WHERE id IN (${placeholders})`)
    .run(authType, Date.now(), ...ids);
  return result.changes;
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
