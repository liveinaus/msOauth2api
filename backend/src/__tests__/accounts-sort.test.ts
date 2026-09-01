/**
 * Server-side ordering of the account list. What matters beyond "it sorts": nulls do not
 * float to the top of a date column, ties break the same way every time so paging cannot
 * repeat or skip a row, and a column name off the query string can never reach the SQL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-accounts-sort-${process.pid}.db`);
process.env.DB_PATH = dbFile;

vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApiAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSendAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  getJwtSecret: () => "test-secret",
}));

let server: Server;
let base: string;
let db: typeof import("../db/database").db;

beforeAll(async () => {
  const express = (await import("express")).default;
  const accounts = (await import("../routes/accounts")).default;
  ({ db } = await import("../db/database"));

  const app = express();
  app.use(express.json());
  app.use("/api/accounts", accounts);
  server = app.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

type Seed = {
  email: string;
  priority?: number;
  lastRefreshAt?: number | null;
  lastUsedAt?: number | null;
  disabled?: number;
};

function seed(rows: Seed[]) {
  db.prepare("DELETE FROM accounts").run();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO accounts
       (email, client_id, refresh_token, priority, last_refresh_at, last_used_at, disabled,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.email,
      "cid",
      "rt",
      row.priority ?? 0,
      row.lastRefreshAt ?? null,
      row.lastUsedAt ?? null,
      row.disabled ?? 0,
      now,
      now,
    );
  }
}

async function emailsFor(query = ""): Promise<string[]> {
  const response = await fetch(`${base}/api/accounts${query}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as Array<{ email: string }>).map((a) => a.email);
}

beforeEach(() => {
  seed([
    { email: "carol@example.com", priority: 5 },
    { email: "alice@example.com", priority: -3 },
    { email: "Bob@example.com", priority: 5 },
  ]);
});

describe("the default order", () => {
  it("is priority, keenest first", async () => {
    // carol and Bob tie on 5, so insertion order decides between them
    expect(await emailsFor()).toEqual([
      "carol@example.com",
      "Bob@example.com",
      "alice@example.com",
    ]);
  });

  it("is what an unrecognised sort falls back to, rather than an error", async () => {
    expect(await emailsFor("?sort=nonsense&dir=sideways")).toEqual(await emailsFor());
  });
});

describe("sorting by a column", () => {
  it("orders by priority ascending when asked", async () => {
    expect(await emailsFor("?sort=priority&dir=asc")).toEqual([
      "alice@example.com",
      "carol@example.com",
      "Bob@example.com",
    ]);
  });

  it("orders by email without regard to case", async () => {
    // A binary sort would put every capital ahead of every lower-case letter
    expect(await emailsFor("?sort=email&dir=asc")).toEqual([
      "alice@example.com",
      "Bob@example.com",
      "carol@example.com",
    ]);
  });

  it("puts the accounts needing attention together", async () => {
    seed([
      { email: "fine@example.com" },
      { email: "off@example.com", disabled: 1 },
      { email: "alsofine@example.com" },
    ]);
    expect((await emailsFor("?sort=status&dir=desc"))[0]).toBe("off@example.com");
    expect((await emailsFor("?sort=status&dir=asc")).at(-1)).toBe("off@example.com");
  });
});

describe("rows with no date in them", () => {
  beforeEach(() => {
    seed([
      { email: "old@example.com", lastRefreshAt: 1000 },
      { email: "never@example.com", lastRefreshAt: null },
      { email: "recent@example.com", lastRefreshAt: 9000 },
    ]);
  });

  // "Never refreshed" is not "refreshed long ago", and it is not "refreshed just now" either
  it("sinks to the bottom whichever way the column is turned", async () => {
    expect(await emailsFor("?sort=lastRefreshAt&dir=desc")).toEqual([
      "recent@example.com",
      "old@example.com",
      "never@example.com",
    ]);
    expect(await emailsFor("?sort=lastRefreshAt&dir=asc")).toEqual([
      "old@example.com",
      "recent@example.com",
      "never@example.com",
    ]);
  });
});

describe("ties", () => {
  // The panel pages this list, so an unstable order would repeat one row and skip another
  it("break on id, so the order is the same every time", async () => {
    seed(Array.from({ length: 12 }, (_, n) => ({ email: `same-${n}@example.com`, priority: 4 })));
    const runs = await Promise.all([emailsFor(), emailsFor(), emailsFor()]);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe("the sort parameter", () => {
  it("cannot reach the SQL", async () => {
    const injection = "?sort=" + encodeURIComponent("priority; DROP TABLE accounts--");
    expect(await emailsFor(injection)).toEqual(await emailsFor());
    // Still standing, and still holding its rows
    expect(await emailsFor()).toHaveLength(3);
  });
});
