/**
 * The nightly token sweep: which accounts it picks up, and when it decides to run.
 *
 * The scheduling half is where the bugs hide -- a missed window, a restart loop, a run that
 * fires twice in one night -- so it is tested as a pure decision against a stored date
 * rather than by waiting on a timer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-auto-refresh-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { db } = await import("../db/database");
const { accountsNeedingRefresh } = await import("../db/accounts");
const { isDue } = await import("../services/autoRefresh");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-01T09:00:00").getTime();

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

function seed(rows: Array<{ email: string; lastRefreshAt: number | null; disabled?: number }>) {
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    `INSERT INTO accounts (email, client_id, refresh_token, last_refresh_at, disabled,
                           created_at, updated_at)
     VALUES (?, 'cid', 'rt', ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.email, row.lastRefreshAt, row.disabled ?? 0, NOW, NOW);
  }
}

beforeEach(() => {
  seed([
    { email: "fresh@example.com", lastRefreshAt: NOW - 2 * DAY },
    { email: "stale@example.com", lastRefreshAt: NOW - 40 * DAY },
    { email: "ancient@example.com", lastRefreshAt: NOW - 200 * DAY },
    { email: "never@example.com", lastRefreshAt: null },
    { email: "off@example.com", lastRefreshAt: NOW - 90 * DAY, disabled: 1 },
  ]);
});

describe("which accounts the sweep picks up", () => {
  const emails = (maxDays: number) => accountsNeedingRefresh(maxDays, NOW).map((a) => a.email);

  it("takes those past the age and leaves the rest", () => {
    expect(emails(30)).toContain("stale@example.com");
    expect(emails(30)).toContain("ancient@example.com");
    expect(emails(30)).not.toContain("fresh@example.com");
  });

  // Whatever was imported or consented, of unknown age
  it("counts a token never refreshed as stale", () => {
    expect(emails(30)).toContain("never@example.com");
  });

  // Refreshing one would put it back in circulation as far as Microsoft is concerned
  it("leaves a disabled account alone", () => {
    expect(emails(1)).not.toContain("off@example.com");
  });

  it("takes the oldest first, so a throttled run gets to them", () => {
    // Nulls lead, then oldest date first
    expect(emails(1)).toEqual([
      "never@example.com",
      "ancient@example.com",
      "stale@example.com",
      "fresh@example.com",
    ]);
  });

  it("finds nothing when every token is inside the window", () => {
    expect(emails(365)).toEqual(["never@example.com"]);
  });
});

describe("deciding whether the sweep is due", () => {
  const at = (iso: string) => new Date(iso);

  it("holds until the hour arrives", () => {
    expect(isDue("2026-08-31", "04:00", at("2026-09-01T03:59:00"))).toBe(false);
    expect(isDue("2026-08-31", "04:00", at("2026-09-01T04:00:00"))).toBe(true);
  });

  // The tick runs every minute; without this it would sweep sixty times an hour
  it("does not run twice in one day", () => {
    expect(isDue("2026-09-01", "04:00", at("2026-09-01T04:00:00"))).toBe(false);
    expect(isDue("2026-09-01", "04:00", at("2026-09-01T23:59:00"))).toBe(false);
  });

  // A container down at 04:00 and back at 06:00 should still refresh that day
  it("catches up a window missed while the process was down", () => {
    expect(isDue("2026-08-30", "04:00", at("2026-09-01T06:00:00"))).toBe(true);
  });

  it("runs again the next day", () => {
    expect(isDue("2026-09-01", "04:00", at("2026-09-02T04:00:00"))).toBe(true);
  });

  it("honours a time other than the default", () => {
    expect(isDue("2026-08-31", "23:30", at("2026-09-01T23:29:00"))).toBe(false);
    expect(isDue("2026-08-31", "23:30", at("2026-09-01T23:30:00"))).toBe(true);
  });
});

describe("the sweep itself", () => {
  it("does nothing at all when the feature is off", async () => {
    const { savePanelSettings } = await import("../db/panelSettings");
    const { runSweep } = await import("../services/autoRefresh");
    savePanelSettings({ autoRefreshMaxDays: 0 });
    expect(await runSweep(new Date(NOW))).toBe(0);
  });

  it("refreshes every stale account and no others", async () => {
    const refreshed: string[] = [];
    vi.doMock("../services/tokenRefresh", () => ({
      refreshAccounts: async (targets: Array<{ id: number; email: string }>) => {
        refreshed.push(...targets.map((t) => t.email));
        return targets.map((t) => ({ id: t.id, email: t.email, ok: true }));
      },
    }));
    vi.resetModules();

    const { savePanelSettings } = await import("../db/panelSettings");
    const { runSweep } = await import("../services/autoRefresh");
    savePanelSettings({ autoRefreshMaxDays: 30 });
    await runSweep(new Date(NOW));

    expect(refreshed.sort()).toEqual([
      "ancient@example.com",
      "never@example.com",
      "stale@example.com",
    ]);
    vi.doUnmock("../services/tokenRefresh");
  });
});
