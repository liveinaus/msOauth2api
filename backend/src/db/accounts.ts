import { db } from "./database";
import { decryptSecret, encryptSecret, encryptionEnabled, isEncrypted } from "./crypto";
import {
  clampPriority,
  parseAuthType,
  parseBlockReason,
  PRIORITY_MAX,
  PRIORITY_MIN,
  type Account,
  type AuthType,
  type BlockReason,
  type OauthPriorityMode,
  type AccountSort,
  type SortDir,
  type VerifyRule,
  DEFAULT_ACCOUNT_SORT,
  DEFAULT_SORT_DIR,
} from "../types";

type AccountRow = {
  id: number;
  email: string;
  password: string | null;
  client_id: string;
  refresh_token: string;
  auth_type: string | null;
  priority: number | null;
  remark: string | null;
  disabled: number;
  block_reason: string | null;
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
  priority?: number;
  remark?: string | null;
  blockReason?: BlockReason | null;
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
    priority: clampPriority(row.priority ?? 0),
    remark: row.remark,
    disabled: row.disabled === 1,
    blockReason: parseBlockReason(row.block_reason),
    lastRefreshAt: row.last_refresh_at,
    lastRefreshError: row.last_refresh_error,
    lastCopiedAt: row.last_copied_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The SQL each sortable column maps to. Nothing else may reach the ORDER BY.
 *
 * `status` is not a column: a row is "bad" when it is disabled or its last refresh failed,
 * and the panel shows those together, so the sort follows what is on screen rather than the
 * storage. Email folds case, or `Zoe` would sort before `adam`.
 */
const SORT_SQL: Record<AccountSort, string> = {
  id: "id",
  priority: "priority",
  email: "email COLLATE NOCASE",
  clientId: "client_id COLLATE NOCASE",
  status: "(disabled = 1 OR last_refresh_error IS NOT NULL)",
  lastRefreshAt: "last_refresh_at",
  lastUsedAt: "last_used_at",
};

/**
 * Every account, ordered by the server.
 *
 * Two details the panel depends on. A row that has never been refreshed or used holds NULL
 * there, and those sort last whichever way the column is turned -- "no date" is not an
 * early date, and burying them under the rows that do have one is what an operator wants
 * either way. And `id` always breaks a tie, so a page boundary cannot show one row twice and
 * skip another when several share a priority.
 */
export function listAccounts(
  sort: AccountSort = DEFAULT_ACCOUNT_SORT,
  dir: SortDir = DEFAULT_SORT_DIR,
): Account[] {
  const column = SORT_SQL[sort] ?? SORT_SQL[DEFAULT_ACCOUNT_SORT];
  const direction = dir === "asc" ? "ASC" : "DESC";
  const nullsLast = sort === "lastRefreshAt" || sort === "lastUsedAt" ? `${column} IS NULL, ` : "";
  const rows = db
    .prepare(`SELECT * FROM accounts ORDER BY ${nullsLast}${column} ${direction}, id ASC`)
    .all() as AccountRow[];
  return rows.map(toAccount);
}

export function getAccount(id: number): Account | undefined {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  return row ? toAccount(row) : undefined;
}

/**
 * The canonical form of an address: trimmed and lower-cased.
 *
 * Addresses reach this panel from someone typing into the form, from an import file and from
 * the OAuth callback, and a mailbox is the same mailbox however it is capitalised. Without
 * one agreed form `John@x.com` and `john@x.com` become two rows -- the UNIQUE index on
 * `email` collates BINARY, so SQLite considers them different -- and the pool then hands out
 * both, one of them carrying a refresh token that Microsoft invalidated when the other was
 * connected.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Addresses that differ only in case, which are the same mailbox held as two rows.
 *
 * Only rows written before addresses were normalised can be like this, and they are not
 * merged automatically: the two carry different refresh tokens and picking a survivor would
 * throw one away. Reported at startup so an operator can delete the stale one.
 */
export function caseDuplicateEmails(): string[][] {
  const rows = db
    .prepare(
      `SELECT GROUP_CONCAT(email, '\n') AS emails
         FROM accounts
        GROUP BY LOWER(email)
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ emails: string }>;
  return rows.map((row) => row.emails.split("\n"));
}

export function getAccountByEmail(email: string): Account | undefined {
  // NOCASE on top of the normalised argument, so a row written in mixed case before this was
  // enforced is still found -- and so updated -- rather than duplicated alongside.
  const row = db
    .prepare("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE")
    .get(normaliseEmail(email)) as AccountRow | undefined;
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
  const email = normaliseEmail(input.email);
  const existing = getAccountByEmail(email);

  if (existing) {
    db.prepare(
      `UPDATE accounts SET
         email         = @email,
         password      = @password,
         client_id     = @clientId,
         refresh_token = @refreshToken,
         auth_type     = COALESCE(@authType, auth_type),
         priority      = COALESCE(@priority, priority),
         remark        = COALESCE(@remark, remark),
         block_reason  = COALESCE(@blockReason, block_reason),
         updated_at    = @now
       WHERE id = @id`,
    ).run({
      id: existing.id,
      email,
      password: input.password ? encryptSecret(input.password) : null,
      clientId: input.clientId,
      refreshToken: encryptSecret(input.refreshToken),
      // Like remark: an import that says nothing about the auth type leaves the one already
      // set alone, so re-importing a plain four-field file cannot silently un-mark an
      // account as IMAP-only.
      authType: input.authType ?? null,
      priority: input.priority === undefined ? null : clampPriority(input.priority),
      remark: input.remark ?? null,
      blockReason: input.blockReason ?? null,
      now,
    });
    // Non-null: the row was just read and updated by id.
    return getAccount(existing.id)!;
  }

  db.prepare(
    `INSERT INTO accounts (email, password, client_id, refresh_token, auth_type, priority, remark,
                           block_reason, created_at, updated_at)
     VALUES (@email, @password, @clientId, @refreshToken, COALESCE(@authType, 'auto'),
             COALESCE(@priority, 0), @remark, @blockReason, @now, @now)
     ON CONFLICT(email) DO UPDATE SET
       password      = excluded.password,
       client_id     = excluded.client_id,
       refresh_token = excluded.refresh_token,
       auth_type     = COALESCE(@authType, accounts.auth_type),
       priority      = COALESCE(@priority, accounts.priority),
       remark        = COALESCE(excluded.remark, accounts.remark),
       block_reason  = COALESCE(excluded.block_reason, accounts.block_reason),
       updated_at    = excluded.updated_at`,
  ).run({
    email,
    password: input.password ? encryptSecret(input.password) : null,
    clientId: input.clientId,
    refreshToken: encryptSecret(input.refreshToken),
    authType: input.authType ?? null,
    priority: input.priority === undefined ? null : clampPriority(input.priority),
    remark: input.remark ?? null,
    blockReason: input.blockReason ?? null,
    now,
  });

  // Non-null: the statement above either inserted this address or updated it.
  return getAccountByEmail(email)!;
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
       priority      = @priority,
       remark        = @remark,
       disabled      = @disabled,
       block_reason  = @blockReason,
       updated_at    = @now
     WHERE id = @id`,
  ).run({
    id,
    email: patch.email ?? existing.email,
    authType: patch.authType ?? existing.authType,
    priority: clampPriority(patch.priority ?? existing.priority),
    password: (() => {
      const next = patch.password === undefined ? existing.password : patch.password;
      return next ? encryptSecret(next) : null;
    })(),
    clientId: patch.clientId ?? existing.clientId,
    refreshToken: encryptSecret(patch.refreshToken ?? existing.refreshToken),
    remark: patch.remark === undefined ? existing.remark : patch.remark,
    disabled: (patch.disabled ?? existing.disabled) ? 1 : 0,
    // Switching an account back on is the operator saying it is well again, so the recorded
    // reason goes with it: a live row carrying "abuse" would read as though it were still out.
    blockReason:
      patch.disabled === false
        ? null
        : patch.blockReason === undefined
          ? existing.blockReason
          : patch.blockReason,
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
 * Moves a set of accounts up or down the queue by `delta`.
 *
 * Relative rather than absolute because that is how the panel's buttons are used: raise the
 * handful being worked on today above the rest, without first having to know what the rest
 * are sitting at. Clamped in SQL so a held-down button cannot run the value away.
 */
export function adjustPriority(ids: number[], delta: number): number {
  if (ids.length === 0 || delta === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE accounts
          SET priority   = MAX(?, MIN(?, priority + ?)),
              updated_at = ?
        WHERE id IN (${placeholders})`,
    )
    .run(PRIORITY_MIN, PRIORITY_MAX, delta, Date.now(), ...ids);
  return result.changes;
}

/**
 * One step above everything currently in the pool, for "use these first" imports.
 *
 * Read once per import so a whole file lands on the same rank rather than each line
 * climbing over the one before it. An empty table starts at 1, and a pool already at the
 * ceiling stays there, which ties with the existing top rather than failing the import.
 */
/**
 * The rank a newly connected account should take, or undefined to leave it at the default.
 *
 * Read at the moment the account is stored rather than when the setting is saved: "one above
 * the highest" has to mean the highest as the pool stands now, not as it stood whenever an
 * operator last opened Settings. An empty pool reads as 0, so the relative modes still give a
 * sensible first rank.
 */
export function priorityForMode(mode: OauthPriorityMode, fixedValue: number): number | undefined {
  if (mode === "normal") return undefined;
  if (mode === "fixed") return clampPriority(fixedValue);

  const row = db
    .prepare("SELECT MAX(priority) AS top, MIN(priority) AS bottom FROM accounts")
    .get() as { top: number | null; bottom: number | null } | undefined;
  const top = row?.top ?? 0;
  const bottom = row?.bottom ?? 0;

  switch (mode) {
    case "highestPlusOne":
      return clampPriority(top + 1);
    case "highest":
      return clampPriority(top);
    case "lowest":
      return clampPriority(bottom);
    case "lowestMinusOne":
      return clampPriority(bottom - 1);
  }
}

/**
 * Takes an account out of the pool with a reason and a note against it.
 *
 * The note is appended rather than written over the remark: an address usually already
 * carries an operator's own, and losing that to an automatic line is worse than a long
 * field. A row already blocked for the same reason is left exactly as it is, so a sweep that
 * keeps meeting the same dead mailbox does not grow its remark by a line every night.
 */
export function blockAccount(id: number, reason: BlockReason, note: string): Account | undefined {
  const existing = getAccount(id);
  if (!existing) return undefined;
  if (existing.disabled && existing.blockReason === reason) return existing;

  const remark = [existing.remark?.trim(), note.trim()].filter(Boolean).join("\n") || null;
  db.prepare(
    `UPDATE accounts SET
       disabled     = 1,
       block_reason = @reason,
       remark       = @remark,
       updated_at   = @now
     WHERE id = @id`,
  ).run({ id, reason, remark, now: Date.now() });

  return getAccount(id);
}

/**
 * The accounts one verification rule is due to check.
 *
 * `last_refresh_at` is the clock rather than a column of its own, because it is stamped on
 * every refresh attempt whether it succeeded or not -- which is exactly "when this account
 * was last put to Microsoft". A token the panel's own button spent this morning is therefore
 * not spent again tonight, and a row that has never been refreshed is due at once, its token
 * being of unknown age.
 *
 * Disabled rows are skipped, as they are by the nightly refresh: they are already out of the
 * pool, and re-checking one would only cost a call to learn what the row already says.
 */
export function accountsNeedingVerify(rule: VerifyRule, now = Date.now()): Account[] {
  const cutoff = now - rule.everyDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT * FROM accounts
        WHERE disabled = 0
          AND priority BETWEEN @from AND @to
          AND (last_refresh_at IS NULL OR last_refresh_at < @cutoff)
        ORDER BY (last_refresh_at IS NOT NULL), last_refresh_at ASC, id ASC`,
    )
    .all({ from: rule.from, to: rule.to, cutoff }) as AccountRow[];
  return rows.map(toAccount);
}

/**
 * Accounts whose token has not been refreshed within `maxDays`, for the nightly sweep.
 *
 * A row that has never been refreshed counts as stale: it holds whatever token was imported
 * or consented, of unknown age. Disabled rows are left alone -- an operator switched those
 * off, and refreshing one would put it back in circulation as far as Microsoft is concerned.
 */
export function accountsNeedingRefresh(maxDays: number, now = Date.now()): Account[] {
  const cutoff = now - maxDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT * FROM accounts
        WHERE disabled = 0
          AND (last_refresh_at IS NULL OR last_refresh_at < ?)
        ORDER BY (last_refresh_at IS NOT NULL), last_refresh_at ASC, id ASC`,
    )
    .all(cutoff) as AccountRow[];
  return rows.map(toAccount);
}

export function nextTopPriority(): number {
  const row = db.prepare("SELECT MAX(priority) AS top FROM accounts").get() as {
    top: number | null;
  };
  return clampPriority((row?.top ?? 0) + 1);
}

/** Sets one priority across a set of accounts, for "back to normal" and for a fixed rank. */
export function setPriority(ids: number[], priority: number): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(`UPDATE accounts SET priority = ?, updated_at = ? WHERE id IN (${placeholders})`)
    .run(clampPriority(priority), Date.now(), ...ids);
  return result.changes;
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
