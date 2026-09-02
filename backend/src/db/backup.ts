/**
 * Whole-system backup: every account with its metadata, the usage rows recorded against it,
 * the type configuration, the panel settings, the API keys and the admin login, in one JSON
 * document that another instance can be restored from.
 *
 * JSON rather than a copy of the SQLite file because secrets are encrypted at rest with
 * MSAPI_DATA_KEY: a file copy is unreadable on an instance holding a different key, or no
 * key at all. Values are exported decrypted and re-encrypted under the target's own key on
 * import, which also makes the format readable and mergeable. The consequence is that the
 * file holds refresh tokens and mailbox passwords in the clear, so it is a secret in its
 * own right -- the same trade the delimited accounts export already makes.
 *
 * Accounts are keyed by address, not by row id. Ids are local to an install and a merge
 * into a populated panel would collide on them; the address is what actually identifies a
 * mailbox on both ends.
 */
import { adminSnapshot, restoreAdminSnapshot, type AdminSnapshot } from "../auth/credentials";
import {
  parseAuthType,
  parseBlockReason,
  parseOauthPriorityMode,
  parsePriority,
  parseVerifyRules,
  type AuthType,
  type BlockReason,
} from "../types";
import { listAccounts } from "./accounts";
import { encryptSecret } from "./crypto";
import { db } from "./database";
import {
  DEFAULT_PANEL_SETTINGS,
  getPanelSettings,
  parseTimeOfDay,
  savePanelSettings,
  type PanelSettings,
} from "./panelSettings";
import { listUsagesByAccount, normaliseType } from "./usages";
import { listUsageTypes } from "./usageTypes";

export const BACKUP_FORMAT = "msoauth2api.backup";
export const BACKUP_VERSION = 1;

export type BackupUsage = {
  type: string;
  leasedAt: number;
  leaseExpiresAt: number | null;
  confirmedAt: number | null;
  code: string | null;
  codeAt: number | null;
};

export type BackupAccount = {
  /** Source row id. Restored as-is by a replace, so the panel's # column survives a move. */
  id: number | null;
  email: string;
  password: string | null;
  clientId: string;
  refreshToken: string;
  authType: AuthType;
  priority: number;
  remark: string | null;
  disabled: boolean;
  blockReason: BlockReason | null;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
  lastCopiedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  usages: BackupUsage[];
};

export type BackupUsageType = {
  id: number | null;
  name: string;
  label: string | null;
  fromFilter: string | null;
  subjectFilter: string | null;
  codePattern: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Only the hash travels; a key itself is unrecoverable, and does not need to be. */
export type BackupApiKey = {
  id: number | null;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt: number | null;
  createdAt: number;
};

/** A raw settings row, so a key this build does not know about still crosses over. */
export type BackupSetting = { key: string; value: string };

export type Backup = {
  format: string;
  version: number;
  exportedAt: number;
  panel: PanelSettings;
  settings: BackupSetting[];
  admin: AdminSnapshot;
  accounts: BackupAccount[];
  usageTypes: BackupUsageType[];
  apiKeys: BackupApiKey[];
};

export type ImportMode = "merge" | "replace";

export type ImportOptions = {
  /** "merge" adds to what is here; "replace" empties the tables the backup covers first. */
  mode: ImportMode;
  /** Off by default: restoring it changes how this instance is signed into. */
  includeAdmin: boolean;
};

export type ImportReport = {
  mode: ImportMode;
  accounts: number;
  usages: number;
  usageTypes: number;
  apiKeys: number;
  settings: number;
  panel: boolean;
  admin: boolean;
  removed: { accounts: number; usageTypes: number; apiKeys: number };
  /** Rows the file carried that could not be applied. The rest of the import still ran. */
  skipped: { where: string; reason: string }[];
};

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

type ApiKeyRow = {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used_at: number | null;
  created_at: number;
};

export function exportBackup(): Backup {
  const usagesByAccount = listUsagesByAccount();
  const apiKeys = db.prepare("SELECT * FROM api_keys ORDER BY id ASC").all() as ApiKeyRow[];

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    panel: getPanelSettings(),
    settings: exportSettings(),
    admin: adminSnapshot(),
    accounts: listAccounts().map((account) => ({
      id: account.id,
      email: account.email,
      password: account.password,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      authType: account.authType,
      priority: account.priority,
      remark: account.remark,
      disabled: account.disabled,
      blockReason: account.blockReason,
      lastRefreshAt: account.lastRefreshAt,
      lastRefreshError: account.lastRefreshError,
      lastCopiedAt: account.lastCopiedAt,
      lastUsedAt: account.lastUsedAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      usages: (usagesByAccount[account.id] ?? []).map((usage) => ({
        type: usage.type,
        leasedAt: usage.leasedAt,
        leaseExpiresAt: usage.leaseExpiresAt,
        confirmedAt: usage.confirmedAt,
        code: usage.code,
        codeAt: usage.codeAt,
      })),
    })),
    usageTypes: listUsageTypes().map((type) => ({
      id: type.id,
      name: type.name,
      label: type.label,
      fromFilter: type.fromFilter,
      subjectFilter: type.subjectFilter,
      codePattern: type.codePattern,
      createdAt: type.createdAt,
      updatedAt: type.updatedAt,
    })),
    apiKeys: apiKeys.map((row) => ({
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Every settings row except the ones that are not the target instance's to inherit.
 *
 * Admin credentials travel in `admin`, behind their own opt-in, and would otherwise ride in
 * here and change the login regardless. The token epoch counts sign-outs on this instance
 * and means nothing on another.
 *
 * Exported wholesale rather than field by field so a setting added in a later release is
 * carried by backups taken with this one.
 */
const LOCAL_SETTING_KEYS = new Set([
  "admin_username",
  "admin_password_hash",
  "admin_password_bootstrap",
  "token_epoch",
]);

function exportSettings(): BackupSetting[] {
  const rows = db
    .prepare("SELECT key, value FROM settings ORDER BY key ASC")
    .all() as BackupSetting[];
  return rows.filter((row) => !LOCAL_SETTING_KEYS.has(row.key));
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed ? trimmed : null;
}

function stamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableStamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validates an uploaded document and returns it in the shape the importer works on.
 *
 * Rows are repaired where a sensible default exists (a missing timestamp becomes "now") and
 * rejected only when something identifying is absent, so one malformed account cannot cost
 * an operator the other nine hundred.
 */
export function parseBackup(input: unknown): { backup: Backup; skipped: ImportReport["skipped"] } {
  const root = asRecord(input);
  if (!root) throw new BackupError("Backup must be a JSON object");
  if (text(root.format) !== BACKUP_FORMAT) {
    throw new BackupError("This file is not an msOauth2api backup");
  }

  const version = stamp(root.version, 0);
  if (version > BACKUP_VERSION) {
    throw new BackupError(
      `Backup version ${version} is newer than this build understands (${BACKUP_VERSION}). Upgrade first.`,
    );
  }

  const now = Date.now();
  const skipped: ImportReport["skipped"] = [];
  const seenEmails = new Set<string>();
  const accounts: BackupAccount[] = [];

  for (const [index, raw] of toArray(root.accounts).entries()) {
    const row = asRecord(raw);
    const where = `accounts[${index}]`;
    if (!row) {
      skipped.push({ where, reason: "not an object" });
      continue;
    }

    const email = text(row.email).toLowerCase();
    const clientId = text(row.clientId);
    const refreshToken = text(row.refreshToken);
    if (!email || !clientId || !refreshToken) {
      skipped.push({ where, reason: "email, clientId and refreshToken are all required" });
      continue;
    }
    if (seenEmails.has(email)) {
      skipped.push({ where: `${where} (${email})`, reason: "duplicate address in the file" });
      continue;
    }
    seenEmails.add(email);

    const createdAt = stamp(row.createdAt, now);
    accounts.push({
      id: nullableStamp(row.id),
      email,
      password: nullableText(row.password),
      clientId,
      refreshToken,
      authType: parseAuthType(row.authType) ?? "auto",
      priority: parsePriority(row.priority) ?? 0,
      remark: nullableText(row.remark),
      disabled: row.disabled === true,
      blockReason: parseBlockReason(row.blockReason),
      lastRefreshAt: nullableStamp(row.lastRefreshAt),
      lastRefreshError: nullableText(row.lastRefreshError),
      lastCopiedAt: nullableStamp(row.lastCopiedAt),
      lastUsedAt: nullableStamp(row.lastUsedAt),
      createdAt,
      updatedAt: stamp(row.updatedAt, createdAt),
      usages: parseUsages(row.usages, where, now, skipped),
    });
  }

  const usageTypes: BackupUsageType[] = [];
  const seenTypes = new Set<string>();
  for (const [index, raw] of toArray(root.usageTypes).entries()) {
    const row = asRecord(raw);
    const where = `usageTypes[${index}]`;
    const name = row ? normaliseType(text(row.name)) : "";
    if (!row || !name) {
      skipped.push({ where, reason: "name is required" });
      continue;
    }
    if (seenTypes.has(name)) {
      skipped.push({ where: `${where} (${name})`, reason: "duplicate type in the file" });
      continue;
    }
    seenTypes.add(name);

    const createdAt = stamp(row.createdAt, now);
    usageTypes.push({
      id: nullableStamp(row.id),
      name,
      label: nullableText(row.label),
      fromFilter: nullableText(row.fromFilter),
      subjectFilter: nullableText(row.subjectFilter),
      codePattern: nullableText(row.codePattern),
      createdAt,
      updatedAt: stamp(row.updatedAt, createdAt),
    });
  }

  const apiKeys: BackupApiKey[] = [];
  for (const [index, raw] of toArray(root.apiKeys).entries()) {
    const row = asRecord(raw);
    const where = `apiKeys[${index}]`;
    const keyHash = row ? text(row.keyHash) : "";
    // The prefix cannot be derived from the hash, and every API call looks a key up by it,
    // so a row without one would restore as a key that can never authenticate.
    const keyPrefix = row ? text(row.keyPrefix) : "";
    if (!row || !keyHash || !keyPrefix) {
      skipped.push({ where, reason: "keyHash and keyPrefix are required" });
      continue;
    }
    apiKeys.push({
      id: nullableStamp(row.id),
      name: text(row.name) || "imported",
      keyHash,
      keyPrefix,
      lastUsedAt: nullableStamp(row.lastUsedAt),
      createdAt: stamp(row.createdAt, now),
    });
  }

  return {
    backup: {
      format: BACKUP_FORMAT,
      version,
      exportedAt: stamp(root.exportedAt, now),
      panel: parsePanel(root.panel),
      settings: parseSettings(root.settings),
      admin: parseAdmin(root.admin),
      accounts,
      usageTypes,
      apiKeys,
    },
    skipped,
  };
}

/** Unknown keys are kept: this is how a setting from a newer release survives the trip. */
function parseSettings(value: unknown): BackupSetting[] {
  const settings: BackupSetting[] = [];
  for (const raw of toArray(value)) {
    const row = asRecord(raw);
    const key = row ? text(row.key) : "";
    if (!key || LOCAL_SETTING_KEYS.has(key) || typeof row?.value !== "string") continue;
    settings.push({ key, value: row.value });
  }
  return settings;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseUsages(
  value: unknown,
  where: string,
  now: number,
  skipped: ImportReport["skipped"],
): BackupUsage[] {
  const usages: BackupUsage[] = [];
  const seen = new Set<string>();

  for (const raw of toArray(value)) {
    const row = asRecord(raw);
    const type = row ? normaliseType(text(row.type)) : "";
    if (!row || !type || seen.has(type)) {
      skipped.push({ where: `${where}.usages`, reason: "type is missing or repeated" });
      continue;
    }
    seen.add(type);
    usages.push({
      type,
      leasedAt: stamp(row.leasedAt, now),
      leaseExpiresAt: nullableStamp(row.leaseExpiresAt),
      confirmedAt: nullableStamp(row.confirmedAt),
      code: nullableText(row.code),
      codeAt: nullableStamp(row.codeAt),
    });
  }
  return usages;
}

/** Out-of-range values are left to savePanelSettings, which clamps them as it always does. */
function parsePanel(value: unknown): PanelSettings {
  const row = asRecord(value);
  if (!row) return { ...DEFAULT_PANEL_SETTINGS };
  const number = (key: keyof PanelSettings, fallback: number): number =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? (row[key] as number) : fallback;

  return {
    pollDurationMinutes: number("pollDurationMinutes", DEFAULT_PANEL_SETTINGS.pollDurationMinutes),
    pollIntervalSeconds: number("pollIntervalSeconds", DEFAULT_PANEL_SETTINGS.pollIntervalSeconds),
    leaseMinutes: number("leaseMinutes", DEFAULT_PANEL_SETTINGS.leaseMinutes),
    usageMode: row.usageMode === "copy" ? "copy" : DEFAULT_PANEL_SETTINGS.usageMode,
    showClientId: row.showClientId === true,
    showRefreshToken: row.showRefreshToken === true,
    oauthClientId: text(row.oauthClientId),
    oauthRedirectUri: text(row.oauthRedirectUri),
    oauthPriorityMode:
      parseOauthPriorityMode(row.oauthPriorityMode) ?? DEFAULT_PANEL_SETTINGS.oauthPriorityMode,
    oauthPriorityValue: number("oauthPriorityValue", DEFAULT_PANEL_SETTINGS.oauthPriorityValue),
    autoRefreshMaxDays: number("autoRefreshMaxDays", DEFAULT_PANEL_SETTINGS.autoRefreshMaxDays),
    autoRefreshAt: parseTimeOfDay(row.autoRefreshAt) ?? DEFAULT_PANEL_SETTINGS.autoRefreshAt,
    verifyRules: parseVerifyRules(row.verifyRules) ?? DEFAULT_PANEL_SETTINGS.verifyRules,
    verifyAt: parseTimeOfDay(row.verifyAt) ?? DEFAULT_PANEL_SETTINGS.verifyAt,
  };
}

function parseAdmin(value: unknown): AdminSnapshot {
  const row = asRecord(value);
  return {
    username: (row && text(row.username)) || "admin",
    passwordHash: row ? nullableText(row.passwordHash) : null,
    usingDefaultPassword: row?.usingDefaultPassword === true,
  };
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Restores a parsed backup.
 *
 * The whole restore is one transaction: a file that fails halfway leaves the panel exactly
 * as it was, rather than half-migrated with no way to tell which half.
 */
export function importBackup(
  backup: Backup,
  options: ImportOptions,
  skipped: ImportReport["skipped"] = [],
): ImportReport {
  const report: ImportReport = {
    mode: options.mode,
    accounts: 0,
    usages: 0,
    usageTypes: 0,
    apiKeys: 0,
    settings: 0,
    panel: false,
    admin: false,
    removed: { accounts: 0, usageTypes: 0, apiKeys: 0 },
    skipped: [...skipped],
  };

  const findAccount = db.prepare("SELECT id FROM accounts WHERE email = ?");
  // Ids come from AUTOINCREMENT and are shown in the panel, so a known address is updated in
  // place: an upsert would consume an id per losing insert and step the counter through a
  // re-import of the whole file.
  const insertAccount = db.prepare(
    `INSERT INTO accounts (email, password, client_id, refresh_token, auth_type, priority, remark,
                           disabled, block_reason, last_refresh_at, last_refresh_error,
                           last_copied_at, last_used_at, created_at, updated_at)
     VALUES (@email, @password, @clientId, @refreshToken, @authType, @priority, @remark, @disabled,
             @blockReason, @lastRefreshAt, @lastRefreshError, @lastCopiedAt, @lastUsedAt,
             @createdAt, @updatedAt)`,
  );
  // Replace restores the source's own ids, so the panel's # column, and anything an
  // operator has written down against it, still points at the same address afterwards.
  // AUTOINCREMENT carries sqlite_sequence forward from the highest id inserted, so the next
  // account added locally does not collide.
  const insertAccountWithId = db.prepare(
    `INSERT INTO accounts (id, email, password, client_id, refresh_token, auth_type, priority,
                           remark, disabled, block_reason, last_refresh_at, last_refresh_error,
                           last_copied_at, last_used_at, created_at, updated_at)
     VALUES (@id, @email, @password, @clientId, @refreshToken, @authType, @priority, @remark,
             @disabled, @blockReason, @lastRefreshAt, @lastRefreshError, @lastCopiedAt,
             @lastUsedAt, @createdAt, @updatedAt)`,
  );
  const updateAccountRow = db.prepare(
    `UPDATE accounts SET
       password           = @password,
       client_id          = @clientId,
       refresh_token      = @refreshToken,
       auth_type          = @authType,
       priority           = @priority,
       remark             = @remark,
       disabled           = @disabled,
       block_reason       = @blockReason,
       last_refresh_at    = @lastRefreshAt,
       last_refresh_error = @lastRefreshError,
       last_copied_at     = @lastCopiedAt,
       last_used_at       = @lastUsedAt,
       created_at         = @createdAt,
       updated_at         = @updatedAt
     WHERE id = @id`,
  );
  const clearUsages = db.prepare("DELETE FROM account_usages WHERE account_id = ?");
  const insertUsage = db.prepare(
    `INSERT INTO account_usages (account_id, type, leased_at, lease_expires_at, confirmed_at, code, code_at)
     VALUES (@accountId, @type, @leasedAt, @leaseExpiresAt, @confirmedAt, @code, @codeAt)`,
  );

  const findType = db.prepare("SELECT id FROM usage_types WHERE name = ?");
  const insertType = db.prepare(
    `INSERT INTO usage_types (name, label, from_filter, subject_filter, code_pattern, created_at, updated_at)
     VALUES (@name, @label, @fromFilter, @subjectFilter, @codePattern, @createdAt, @updatedAt)`,
  );
  const insertTypeWithId = db.prepare(
    `INSERT INTO usage_types (id, name, label, from_filter, subject_filter, code_pattern, created_at, updated_at)
     VALUES (@id, @name, @label, @fromFilter, @subjectFilter, @codePattern, @createdAt, @updatedAt)`,
  );
  const updateType = db.prepare(
    `UPDATE usage_types SET
       label          = @label,
       from_filter    = @fromFilter,
       subject_filter = @subjectFilter,
       code_pattern   = @codePattern,
       created_at     = @createdAt,
       updated_at     = @updatedAt
     WHERE id = @id`,
  );

  const writeSetting = db.prepare(
    "INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  const findKey = db.prepare("SELECT id FROM api_keys WHERE key_hash = ?");
  const insertKey = db.prepare(
    `INSERT INTO api_keys (name, key_hash, key_prefix, last_used_at, created_at)
     VALUES (@name, @keyHash, @keyPrefix, @lastUsedAt, @createdAt)`,
  );
  const insertKeyWithId = db.prepare(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, last_used_at, created_at)
     VALUES (@id, @name, @keyHash, @keyPrefix, @lastUsedAt, @createdAt)`,
  );

  const run = db.transaction(() => {
    if (options.mode === "replace") {
      // account_usages goes with its account through the foreign key's cascade.
      report.removed.accounts = db.prepare("DELETE FROM accounts").run().changes;
      report.removed.usageTypes = db.prepare("DELETE FROM usage_types").run().changes;
      report.removed.apiKeys = db.prepare("DELETE FROM api_keys").run().changes;
    }

    for (const account of backup.accounts) {
      const values = {
        email: account.email,
        password: account.password ? encryptSecret(account.password) : null,
        clientId: account.clientId,
        refreshToken: encryptSecret(account.refreshToken),
        authType: account.authType,
        priority: account.priority,
        remark: account.remark,
        disabled: account.disabled ? 1 : 0,
        blockReason: account.blockReason,
        lastRefreshAt: account.lastRefreshAt,
        lastRefreshError: account.lastRefreshError,
        lastCopiedAt: account.lastCopiedAt,
        lastUsedAt: account.lastUsedAt,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      };

      const existing = findAccount.get(account.email) as { id: number } | undefined;
      const keepId = options.mode === "replace" && account.id !== null;
      const id = existing
        ? (updateAccountRow.run({ ...values, id: existing.id }), existing.id)
        : keepId
          ? (insertAccountWithId.run({ ...values, id: account.id }), account.id as number)
          : Number(insertAccount.run(values).lastInsertRowid);
      report.accounts++;

      // The imported row replaces the stored one wholesale, so its usage history replaces
      // what was recorded here too. Leaving both would resurrect claims the source instance
      // had already cleared.
      clearUsages.run(id);
      for (const usage of account.usages) {
        insertUsage.run({ accountId: id, ...usage });
        report.usages++;
      }
    }

    for (const type of backup.usageTypes) {
      const existing = findType.get(type.name) as { id: number } | undefined;
      if (existing) updateType.run({ ...type, id: existing.id });
      else if (options.mode === "replace" && type.id !== null) insertTypeWithId.run(type);
      else insertType.run(type);
      report.usageTypes++;
    }

    for (const key of backup.apiKeys) {
      // The hash identifies the key; a second copy would authenticate the same secret twice.
      if (findKey.get(key.keyHash)) continue;
      if (options.mode === "replace" && key.id !== null) insertKeyWithId.run(key);
      else insertKey.run(key);
      report.apiKeys++;
    }

    // Settings before the panel block, so the typed values win over any stale raw row and
    // the clamping in savePanelSettings still has the last word.
    for (const setting of backup.settings) {
      writeSetting.run(setting);
      report.settings++;
    }

    savePanelSettings(backup.panel);
    report.panel = true;

    if (options.includeAdmin && backup.admin.passwordHash) {
      restoreAdminSnapshot(backup.admin);
      report.admin = true;
    }
  });

  run();
  return report;
}
