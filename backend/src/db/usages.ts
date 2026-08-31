/**
 * Per-type address allocation for integrations.
 *
 * An address is handed out for a type ("telegram") under a lease. If the code never turns
 * up the lease lapses and the address returns to the pool, so an abandoned signup does not
 * consume it; once a code is found the row is confirmed and that address is retired for
 * that type. Being used for one type says nothing about the others.
 */
import { db } from "./database";
import { getAccount } from "./accounts";
import type { Account } from "../types";

export type Usage = {
  id: number;
  accountId: number;
  type: string;
  leasedAt: number;
  leaseExpiresAt: number | null;
  confirmedAt: number | null;
  code: string | null;
  codeAt: number | null;
};

type UsageRow = {
  id: number;
  account_id: number;
  type: string;
  leased_at: number;
  lease_expires_at: number | null;
  confirmed_at: number | null;
  code: string | null;
  code_at: number | null;
};

function toUsage(row: UsageRow): Usage {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    leasedAt: row.leased_at,
    leaseExpiresAt: row.lease_expires_at,
    confirmedAt: row.confirmed_at,
    code: row.code,
    codeAt: row.code_at,
  };
}

/** Types are caller-supplied labels, so they are matched case- and space-insensitively. */
export function normaliseType(value: string): string {
  return value.trim().toLowerCase();
}

export function getUsage(accountId: number, type: string): Usage | undefined {
  const row = db
    .prepare("SELECT * FROM account_usages WHERE account_id = ? AND type = ?")
    .get(accountId, normaliseType(type)) as UsageRow | undefined;
  return row ? toUsage(row) : undefined;
}

/** Every usage row, grouped by account, for the panel's list in one query rather than N. */
export function listUsagesByAccount(): Record<number, Usage[]> {
  const rows = db
    .prepare("SELECT * FROM account_usages ORDER BY leased_at DESC")
    .all() as UsageRow[];

  const grouped: Record<number, Usage[]> = {};
  for (const row of rows) {
    (grouped[row.account_id] ??= []).push(toUsage(row));
  }
  return grouped;
}

export function listUsages(accountId: number): Usage[] {
  const rows = db
    .prepare("SELECT * FROM account_usages WHERE account_id = ? ORDER BY leased_at DESC")
    .all(accountId) as UsageRow[];
  return rows.map(toUsage);
}

/**
 * A row blocks an address only while it is confirmed or its lease still stands. Kept as SQL
 * text because both the claim and the counts have to agree on the definition exactly.
 */
const UNAVAILABLE = `
  u.id IS NOT NULL
  AND (u.confirmed_at IS NOT NULL OR (u.lease_expires_at IS NOT NULL AND u.lease_expires_at > @now))
`;

export type LeaseResult =
  { ok: true; account: Account; usage: Usage } | { ok: false; reason: "none-available" };

/**
 * Claims the next free address for a type.
 *
 * Selection and write happen in one transaction so two callers arriving together cannot be
 * handed the same address. Addresses whose last lease expired go to the back of the queue,
 * which spreads use around the pool rather than hammering the lowest id.
 *
 * Priority is read first, so a marked address is spent before the rest of the pool is
 * touched; within one priority the round-robin above still applies.
 *
 * Accounts carrying a refresh error are skipped: they cannot fetch mail, so an address that
 * cannot receive a code is worse than none at all.
 */
export function leaseAccount(type: string, leaseMs: number): LeaseResult {
  const kind = normaliseType(type);
  const claim = db.transaction((now: number): LeaseResult => {
    const row = db
      .prepare(
        `SELECT a.id AS account_id, COALESCE(u.leased_at, 0) AS last_leased
           FROM accounts a
           LEFT JOIN account_usages u ON u.account_id = a.id AND u.type = @type
          WHERE a.disabled = 0
            AND a.last_refresh_error IS NULL
            AND NOT (${UNAVAILABLE})
          ORDER BY a.priority DESC, last_leased ASC, a.id ASC
          LIMIT 1`,
      )
      .get({ type: kind, now }) as { account_id: number } | undefined;

    if (!row) return { ok: false, reason: "none-available" };

    db.prepare(
      `INSERT INTO account_usages (account_id, type, leased_at, lease_expires_at)
       VALUES (@accountId, @type, @now, @expires)
       ON CONFLICT(account_id, type) DO UPDATE SET
         leased_at        = excluded.leased_at,
         lease_expires_at = excluded.lease_expires_at,
         confirmed_at     = NULL,
         code             = NULL,
         code_at          = NULL`,
    ).run({ accountId: row.account_id, type: kind, now, expires: now + leaseMs });

    // Non-null: both rows were just read or written inside this transaction.
    return {
      ok: true,
      account: getAccount(row.account_id)!,
      usage: getUsage(row.account_id, kind)!,
    };
  });

  return claim(Date.now());
}

/**
 * Claims one named address for a type, as opposed to picking whichever is free.
 *
 * This is the panel's copy button: the operator has chosen the address already, so there is
 * nothing to select, but the claim still needs recording and still expires on its own.
 */
export function leaseSpecific(accountId: number, type: string, leaseMs: number): Usage | undefined {
  const now = Date.now();
  const kind = normaliseType(type);
  db.prepare(
    `INSERT INTO account_usages (account_id, type, leased_at, lease_expires_at)
     VALUES (@accountId, @type, @now, @expires)
     ON CONFLICT(account_id, type) DO UPDATE SET
       leased_at        = excluded.leased_at,
       lease_expires_at = excluded.lease_expires_at,
       confirmed_at     = NULL,
       code             = NULL,
       code_at          = NULL`,
  ).run({ accountId, type: kind, now, expires: now + leaseMs });
  return getUsage(accountId, kind);
}

/** Removes a usage outright, confirmed or not. The panel's manual unmark. */
export function clearUsage(accountId: number, type: string): boolean {
  const result = db
    .prepare("DELETE FROM account_usages WHERE account_id = ? AND type = ?")
    .run(accountId, normaliseType(type));
  return result.changes > 0;
}

/** Retires the address for this type. Called when a code is found, or confirmed by hand. */
export function confirmUsage(
  accountId: number,
  type: string,
  code: string | null,
): Usage | undefined {
  const now = Date.now();
  const kind = normaliseType(type);
  db.prepare(
    `INSERT INTO account_usages (account_id, type, leased_at, lease_expires_at, confirmed_at, code, code_at)
     VALUES (@accountId, @type, @now, NULL, @now, @code, @codeAt)
     ON CONFLICT(account_id, type) DO UPDATE SET
       lease_expires_at = NULL,
       confirmed_at     = COALESCE(account_usages.confirmed_at, @now),
       code             = COALESCE(@code, account_usages.code),
       code_at          = COALESCE(@codeAt, account_usages.code_at)`,
  ).run({ accountId, type: kind, now, code, codeAt: code ? now : null });
  return getUsage(accountId, kind);
}

/** Frees an address early, for a signup that was abandoned. Confirmed rows are left alone. */
export function releaseUsage(accountId: number, type: string): boolean {
  const result = db
    .prepare(
      "DELETE FROM account_usages WHERE account_id = ? AND type = ? AND confirmed_at IS NULL",
    )
    .run(accountId, normaliseType(type));
  return result.changes > 0;
}

export type PoolStats = { type: string; available: number; leased: number; confirmed: number };

/** Capacity for a type, so a caller can tell "none free" from "none left" before it runs dry. */
export function poolStats(type: string): PoolStats {
  const kind = normaliseType(type);
  const now = Date.now();

  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN u.confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN u.confirmed_at IS NULL AND u.lease_expires_at > @now THEN 1 ELSE 0 END) AS leased
       FROM account_usages u
       JOIN accounts a ON a.id = u.account_id
       WHERE u.type = @type AND a.disabled = 0`,
    )
    .get({ type: kind, now }) as { confirmed: number | null; leased: number | null };

  const usable = db
    .prepare("SELECT COUNT(*) AS n FROM accounts WHERE disabled = 0 AND last_refresh_error IS NULL")
    .get() as { n: number };

  const confirmed = row.confirmed ?? 0;
  const leased = row.leased ?? 0;
  return { type: kind, available: Math.max(0, usable.n - confirmed - leased), leased, confirmed };
}
