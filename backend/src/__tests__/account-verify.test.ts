/**
 * Service abuse mode, and the scheduled check that finds it.
 *
 * Two halves worth testing separately. Recognising the verdict has to be narrow: it disables
 * the account outright on a single reply, where an ordinary grant rejection waits for a
 * second one, so a wrong match takes a working mailbox out of the pool for good. And which
 * accounts a rule picks up is arithmetic on a band and an interval, which is where an
 * off-by-one quietly means "checked nothing" or "checked the lot every night".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-account-verify-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { db } = await import("../db/database");
const { blockAccount, getAccount, listAccounts } = await import("../db/accounts");
const { dueAccounts } = await import("../services/accountVerify");
const { isAbuseBlock, describeOAuthError, OAuthError } = await import("../services/oauth");
const { parseVerifyRule, parseVerifyRules } = await import("../types");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-01T09:00:00").getTime();

/** Microsoft's reply for a mailbox it has put into service abuse mode. */
const ABUSE_BODY = JSON.stringify({
  error: "invalid_grant",
  error_description:
    "AADSTS70000: User account is found to be in service abuse mode. Trace ID: abc-123",
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

function seed(
  rows: Array<{
    email: string;
    priority: number;
    lastRefreshAt: number | null;
    disabled?: number;
    remark?: string | null;
  }>,
) {
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    `INSERT INTO accounts (email, client_id, refresh_token, priority, last_refresh_at, disabled,
                           remark, created_at, updated_at)
     VALUES (?, 'cid', 'rt', ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.email,
      row.priority,
      row.lastRefreshAt,
      row.disabled ?? 0,
      row.remark ?? null,
      NOW,
      NOW,
    );
  }
}

beforeEach(() => {
  seed([
    { email: "bottom@example.com", priority: -99, lastRefreshAt: NOW - 5 * DAY },
    { email: "bottom-fresh@example.com", priority: -99, lastRefreshAt: NOW - 2 * DAY },
    { email: "normal@example.com", priority: 0, lastRefreshAt: NOW - 30 * DAY },
    { email: "keen@example.com", priority: 50, lastRefreshAt: NOW - 30 * DAY },
    { email: "never@example.com", priority: 20, lastRefreshAt: null },
    { email: "off@example.com", priority: -99, lastRefreshAt: NOW - 90 * DAY, disabled: 1 },
  ]);
});

describe("recognising service abuse mode", () => {
  it("matches Microsoft's wording", () => {
    expect(isAbuseBlock(new OAuthError(400, ABUSE_BODY))).toBe(true);
  });

  // The account is only out because the phrase is there, so a plain expired token, which
  // carries the same AADSTS number, must not be swept up with it
  it("does not match an ordinary rejected grant on the same error code", () => {
    const expired = new OAuthError(
      400,
      '{"error":"invalid_grant","error_description":"AADSTS70000: The provided grant has expired."}',
    );
    expect(isAbuseBlock(expired)).toBe(false);
  });

  it("does not match a throttled or unwell endpoint", () => {
    expect(isAbuseBlock(new OAuthError(429, "Too many requests"))).toBe(false);
    expect(isAbuseBlock(new OAuthError(503, "Service Unavailable"))).toBe(false);
  });

  it("does not match a fault that never reached the endpoint", () => {
    expect(isAbuseBlock(new Error("Microsoft token endpoint did not respond within 30s"))).toBe(
      false,
    );
  });

  // The raw body is a JSON blob with correlation ids in it, which is no use on a row
  it("reduces the reply to its description", () => {
    expect(describeOAuthError(ABUSE_BODY)).toContain("service abuse mode");
    expect(describeOAuthError(ABUSE_BODY)).not.toContain("invalid_grant");
  });

  it("falls back to the body when the reply is not JSON", () => {
    expect(describeOAuthError("Bad Gateway")).toBe("Bad Gateway");
  });
});

describe("blocking an account", () => {
  const idFor = (email: string) => listAccounts().find((a) => a.email === email)!.id;

  it("takes it out of the pool with a reason and a note", () => {
    const id = idFor("normal@example.com");
    blockAccount(id, "abuse", "service abuse mode");

    const account = getAccount(id)!;
    expect(account.disabled).toBe(true);
    expect(account.blockReason).toBe("abuse");
    expect(account.remark).toBe("service abuse mode");
  });

  // Losing an operator's own note to an automatic line is worse than a long field
  it("keeps a remark that was already there", () => {
    seed([{ email: "noted@example.com", priority: 0, lastRefreshAt: null, remark: "bought Jan" }]);
    const id = idFor("noted@example.com");
    blockAccount(id, "abuse", "service abuse mode");

    expect(getAccount(id)!.remark).toBe("bought Jan\nservice abuse mode");
  });

  // Otherwise a sweep meeting the same dead mailbox grows its remark by a line a night
  it("leaves a row already blocked for the same reason alone", () => {
    const id = idFor("normal@example.com");
    blockAccount(id, "abuse", "first");
    blockAccount(id, "abuse", "second");

    expect(getAccount(id)!.remark).toBe("first");
  });

  it("clears the reason when the account is switched back on", async () => {
    const { updateAccount } = await import("../db/accounts");
    const id = idFor("normal@example.com");
    blockAccount(id, "abuse", "service abuse mode");

    const enabled = updateAccount(id, { disabled: false })!;
    expect(enabled.disabled).toBe(false);
    expect(enabled.blockReason).toBe(null);
  });
});

describe("which accounts a rule is due to check", () => {
  const emails = (everyDays: number, from: number, to: number) =>
    dueAccounts([{ everyDays, from, to }], NOW).map((a) => a.email);

  it("takes only the band it names", () => {
    expect(emails(3, -99, -99)).toEqual(["bottom@example.com"]);
  });

  it("respects the interval inside the band", () => {
    // bottom-fresh was checked two days ago, so a three-day rule leaves it be
    expect(emails(3, -99, -99)).not.toContain("bottom-fresh@example.com");
    expect(emails(1, -99, -99)).toContain("bottom-fresh@example.com");
  });

  it("treats the bounds as inclusive", () => {
    expect(emails(7, 11, 99)).toEqual(["never@example.com", "keen@example.com"]);
    expect(emails(7, 21, 99)).toEqual(["keen@example.com"]);
  });

  // Its token is whatever was imported or consented, of unknown age
  it("counts an account never refreshed as due", () => {
    expect(emails(365, -99, 99)).toEqual(["never@example.com"]);
  });

  // Already out of the pool: a call would only confirm what the row says
  it("skips a disabled account", () => {
    expect(emails(1, -99, -99)).not.toContain("off@example.com");
  });

  it("charges an account matching two overlapping rules only once", () => {
    const due = dueAccounts(
      [
        { everyDays: 3, from: -99, to: 99 },
        { everyDays: 7, from: -99, to: 0 },
      ],
      NOW,
    );
    expect(due.filter((a) => a.email === "bottom@example.com")).toHaveLength(1);
  });

  it("checks nothing when there are no rules", () => {
    expect(dueAccounts([], NOW)).toEqual([]);
  });
});

describe("reading a rule off the wire", () => {
  it("swaps bounds filled in the wrong order, which would otherwise match nothing", () => {
    expect(parseVerifyRule({ everyDays: 3, from: 99, to: 10 })).toEqual({
      everyDays: 3,
      from: 10,
      to: 99,
    });
  });

  it("clamps a band to the priority range", () => {
    expect(parseVerifyRule({ everyDays: 3, from: -500, to: 500 })).toEqual({
      everyDays: 3,
      from: -99,
      to: 99,
    });
  });

  it("rejects a rule with no usable interval", () => {
    expect(parseVerifyRule({ everyDays: 0, from: 0, to: 0 })).toBe(null);
    expect(parseVerifyRule({ from: 0, to: 0 })).toBe(null);
    expect(parseVerifyRule(null)).toBe(null);
  });

  it("drops an unusable rule without losing the rest of the list", () => {
    expect(parseVerifyRules([{ everyDays: 3, from: 0, to: 0 }, "nonsense"])).toEqual([
      { everyDays: 3, from: 0, to: 0 },
    ]);
  });

  // An empty list is how the check is switched off, and has to survive as one
  it("tells an empty list apart from no list at all", () => {
    expect(parseVerifyRules([])).toEqual([]);
    expect(parseVerifyRules(undefined)).toBe(null);
  });
});

describe("what a refresh does with the verdict", () => {
  const idFor = (email: string) => listAccounts().find((a) => a.email === email)!.id;

  it("disables the account on the first sighting, with the reason on the row", async () => {
    vi.doMock("../services/oauth", async () => {
      const actual = await import("../services/oauth");
      return {
        ...actual,
        exchangeRefreshToken: async () => {
          throw new actual.OAuthError(400, ABUSE_BODY);
        },
      };
    });
    vi.resetModules();

    const { refreshAccounts } = await import("../services/tokenRefresh");
    const { getAccount: read } = await import("../db/accounts");
    const target = listAccounts().find((a) => a.email === "normal@example.com")!;

    const [result] = await refreshAccounts([target]);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe("abuse");

    const account = read(target.id)!;
    expect(account.disabled).toBe(true);
    expect(account.blockReason).toBe("abuse");
    expect(account.remark).toContain("service abuse mode");
    // Dated, so an operator can tell a block from last night from one from March
    expect(account.remark).toMatch(/^\[auto \d{4}-\d{2}-\d{2}\] /);

    vi.doUnmock("../services/oauth");
    vi.resetModules();
  });

  // A dead token still gets its two strikes; only the abuse verdict short-circuits that
  it("leaves an ordinary rejected grant enabled", async () => {
    vi.doMock("../services/oauth", async () => {
      const actual = await import("../services/oauth");
      return {
        ...actual,
        exchangeRefreshToken: async () => {
          throw new actual.OAuthError(
            400,
            '{"error":"invalid_grant","error_description":"AADSTS70000: expired"}',
          );
        },
      };
    });
    vi.resetModules();

    const { refreshAccounts } = await import("../services/tokenRefresh");
    const { getAccount: read } = await import("../db/accounts");
    const target = listAccounts().find((a) => a.email === "keen@example.com")!;

    const [result] = await refreshAccounts([target]);
    expect(result.blocked).toBeUndefined();

    const account = read(target.id)!;
    expect(account.disabled).toBe(false);
    expect(account.blockReason).toBe(null);

    vi.doUnmock("../services/oauth");
    vi.resetModules();
  });

  it("does not touch the row when the refresh works", async () => {
    vi.doMock("../services/oauth", async () => {
      const actual = await import("../services/oauth");
      return {
        ...actual,
        exchangeRefreshToken: async () => ({
          accessToken: "at",
          refreshToken: "next-rt",
          scope: "",
        }),
      };
    });
    vi.resetModules();

    const { refreshAccounts } = await import("../services/tokenRefresh");
    const { getAccount: read } = await import("../db/accounts");
    const target = listAccounts().find((a) => a.email === "normal@example.com")!;

    const [result] = await refreshAccounts([target]);
    expect(result.ok).toBe(true);
    expect(read(target.id)!.disabled).toBe(false);

    vi.doUnmock("../services/oauth");
    vi.resetModules();
  });
});

describe("storing the rules", () => {
  it("round-trips a list through the settings table", async () => {
    const { getPanelSettings, savePanelSettings } = await import("../db/panelSettings");
    savePanelSettings({
      verifyRules: [
        { everyDays: 3, from: -99, to: -99 },
        { everyDays: 14, from: 11, to: 99 },
      ],
      verifyAt: "5:30",
    });

    const settings = getPanelSettings();
    expect(settings.verifyRules).toEqual([
      { everyDays: 3, from: -99, to: -99 },
      { everyDays: 14, from: 11, to: 99 },
    ]);
    expect(settings.verifyAt).toBe("05:30");
  });

  it("saves an empty list, which is how the check is turned off", async () => {
    const { getPanelSettings, savePanelSettings } = await import("../db/panelSettings");
    savePanelSettings({ verifyRules: [{ everyDays: 3, from: 0, to: 0 }] });
    savePanelSettings({ verifyRules: [] });

    expect(getPanelSettings().verifyRules).toEqual([]);
  });

  it("reads an unreadable stored value as no rules rather than throwing", async () => {
    const { setSetting } = await import("../db/database");
    const { getPanelSettings } = await import("../db/panelSettings");
    setSetting("panel.verify_rules", "{not json");

    expect(getPanelSettings().verifyRules).toEqual([]);
  });
});
