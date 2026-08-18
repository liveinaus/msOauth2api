import { beforeEach, describe, expect, it } from "vitest";
import { getAccountByEmail, upsertAccount } from "../db/accounts";
import { BackupError, exportBackup, importBackup, parseBackup } from "../db/backup";
import { db, getSetting } from "../db/database";
import { getPanelSettings, savePanelSettings } from "../db/panelSettings";
import { confirmUsage, leaseSpecific, listUsages } from "../db/usages";
import { createUsageType, getUsageTypeByName, listUsageTypes } from "../db/usageTypes";

/** A backup crosses a process boundary as JSON, so tests re-read it the same way. */
function roundTrip() {
  const parsed = parseBackup(JSON.parse(JSON.stringify(exportBackup())));
  return parsed;
}

function wipe(): void {
  db.prepare("DELETE FROM accounts").run();
  db.prepare("DELETE FROM usage_types").run();
  db.prepare("DELETE FROM api_keys").run();
}

function seed(): void {
  const account = upsertAccount({
    email: "one@example.com",
    password: "pw-one",
    clientId: "cid-one",
    refreshToken: "rt-one",
    authType: "imap",
    remark: "first",
  });
  upsertAccount({ email: "two@example.com", clientId: "cid-two", refreshToken: "rt-two" });

  leaseSpecific(account.id, "telegram", 60_000);
  confirmUsage(account.id, "discord", "445566");

  createUsageType({ name: "telegram", label: "Telegram", codePattern: "(\\d{5})" });

  db.prepare(
    "INSERT INTO api_keys (name, key_hash, key_prefix, last_used_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("script", "argon2-hash", "msk_abcdefgh", null, 1_700_000_000_000);
}

describe("backup", () => {
  beforeEach(() => {
    wipe();
    savePanelSettings({
      pollDurationMinutes: 5,
      pollIntervalSeconds: 20,
      leaseMinutes: 15,
      usageMode: "mail",
      showClientId: false,
      showRefreshToken: false,
    });
    seed();
  });

  it("carries every account with its metadata and usage rows", () => {
    const { backup, skipped } = roundTrip();
    expect(skipped).toEqual([]);

    const one = backup.accounts.find((a) => a.email === "one@example.com");
    expect(one).toMatchObject({
      password: "pw-one",
      clientId: "cid-one",
      refreshToken: "rt-one",
      authType: "imap",
      remark: "first",
      disabled: false,
    });
    expect(one?.usages.map((u) => u.type).sort()).toEqual(["discord", "telegram"]);
    expect(one?.usages.find((u) => u.type === "discord")?.code).toBe("445566");
    expect(backup.usageTypes).toHaveLength(1);
    expect(backup.apiKeys).toEqual([
      {
        id: expect.any(Number),
        name: "script",
        keyHash: "argon2-hash",
        keyPrefix: "msk_abcdefgh",
        lastUsedAt: null,
        createdAt: 1_700_000_000_000,
      },
    ]);
  });

  it("restores an emptied instance to what was exported", () => {
    const { backup } = roundTrip();
    wipe();

    const report = importBackup(backup, { mode: "replace", includeAdmin: false });
    expect(report).toMatchObject({ accounts: 2, usages: 2, usageTypes: 1, apiKeys: 1 });

    const restored = getAccountByEmail("one@example.com");
    expect(restored).toMatchObject({
      password: "pw-one",
      refreshToken: "rt-one",
      authType: "imap",
      remark: "first",
    });
    // Timestamps are part of the metadata, not stamped afresh on import.
    expect(restored?.createdAt).toBe(backup.accounts[0].createdAt);
    expect(listUsages(restored!.id)).toHaveLength(2);
    expect(getUsageTypeByName("telegram")?.codePattern).toBe("(\\d{5})");
    expect(getPanelSettings().leaseMinutes).toBe(15);
  });

  it("gives back the same row ids on a replace, so the panel's # column survives", () => {
    const { backup } = roundTrip();
    const ids = Object.fromEntries(backup.accounts.map((a) => [a.email, a.id]));
    const typeIds = Object.fromEntries(backup.usageTypes.map((t) => [t.name, t.id]));
    wipe();

    importBackup(backup, { mode: "replace", includeAdmin: false });

    expect(getAccountByEmail("one@example.com")?.id).toBe(ids["one@example.com"]);
    expect(getAccountByEmail("two@example.com")?.id).toBe(ids["two@example.com"]);
    expect(getUsageTypeByName("telegram")?.id).toBe(typeIds.telegram);

    // The id counter has to move past what was restored, or the next account added here
    // would collide with a restored row.
    const added = upsertAccount({
      email: "after@example.com",
      clientId: "cid",
      refreshToken: "rt",
    });
    expect(added.id).toBeGreaterThan(Math.max(...Object.values(ids).map((id) => id ?? 0)));
  });

  it("carries settings rows the typed panel fields do not cover", () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "panel.something_new",
      "kept",
    );
    // Local-only rows must not travel: they would change the login or the session epoch.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "token_epoch",
      "7",
    );

    const { backup } = roundTrip();
    expect(backup.settings.map((s) => s.key)).toContain("panel.something_new");
    expect(backup.settings.map((s) => s.key)).not.toContain("token_epoch");
    expect(backup.settings.map((s) => s.key)).not.toContain("admin_password_hash");

    db.prepare("DELETE FROM settings WHERE key = ?").run("panel.something_new");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "token_epoch",
      "9",
    );

    importBackup(backup, { mode: "replace", includeAdmin: false });

    expect(getSetting("panel.something_new")).toBe("kept");
    expect(getSetting("token_epoch")).toBe("9");
  });

  it("updates a known address in place rather than adding a second row", () => {
    const { backup } = roundTrip();
    const before = getAccountByEmail("one@example.com")!;

    backup.accounts[0].remark = "edited elsewhere";
    importBackup(backup, { mode: "merge", includeAdmin: false });

    const after = getAccountByEmail("one@example.com")!;
    expect(after.id).toBe(before.id);
    expect(after.remark).toBe("edited elsewhere");
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({ n: 2 });
  });

  it("keeps accounts the file does not mention when merging, and drops them when replacing", () => {
    const { backup } = roundTrip();
    backup.accounts = backup.accounts.filter((a) => a.email === "one@example.com");

    importBackup(backup, { mode: "merge", includeAdmin: false });
    expect(getAccountByEmail("two@example.com")).toBeDefined();

    const replaced = importBackup(backup, { mode: "replace", includeAdmin: false });
    expect(getAccountByEmail("two@example.com")).toBeUndefined();
    expect(replaced.removed.accounts).toBe(2);
  });

  it("does not import the same API key twice", () => {
    const { backup } = roundTrip();
    importBackup(backup, { mode: "merge", includeAdmin: false });
    const second = importBackup(backup, { mode: "merge", includeAdmin: false });

    expect(second.apiKeys).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_keys").get()).toEqual({ n: 1 });
  });

  it("leaves the admin login alone unless asked", () => {
    const { backup } = roundTrip();
    expect(importBackup(backup, { mode: "merge", includeAdmin: false }).admin).toBe(false);
  });

  it("skips unusable rows instead of failing the whole file", () => {
    const document = JSON.parse(JSON.stringify(exportBackup()));
    document.accounts.push({ email: "", clientId: "c", refreshToken: "r" });
    document.accounts.push({ email: "one@example.com", clientId: "c", refreshToken: "r" });
    document.apiKeys.push({ name: "no prefix", keyHash: "h" });

    const { backup, skipped } = parseBackup(document);
    expect(backup.accounts).toHaveLength(2);
    expect(skipped).toHaveLength(3);
  });

  it("rejects a document that is not a backup", () => {
    expect(() => parseBackup({ hello: "world" })).toThrow(BackupError);
    expect(() => parseBackup({ format: "msoauth2api.backup", version: 99, accounts: [] })).toThrow(
      /newer than this build/,
    );
  });

  it("restores type configuration over an existing row of the same name", () => {
    const { backup } = roundTrip();
    backup.usageTypes[0].label = "TG";
    importBackup(backup, { mode: "merge", includeAdmin: false });

    expect(listUsageTypes()).toHaveLength(1);
    expect(getUsageTypeByName("telegram")?.label).toBe("TG");
  });
});
