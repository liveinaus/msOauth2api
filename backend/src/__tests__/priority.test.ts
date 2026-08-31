/**
 * Pool priority: the ordering the API hands addresses out in, and the bulk edit behind the
 * panel's bump buttons. Real HTTP against a throwaway database, auth and mail stubbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-priority-${process.pid}.db`);
process.env.DB_PATH = dbFile;

vi.mock("../middleware/auth", () => ({
  requireApiAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSendAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  getJwtSecret: () => "test-secret",
}));

vi.mock("../services/mail", () => ({
  readFolders: async () => ({
    transport: "graph" as const,
    rotatedRefreshToken: null,
    messages: [],
  }),
  pickForPanel: () => null,
}));

let server: Server;
let base: string;
let upsertAccount: typeof import("../db/accounts").upsertAccount;
let getAccountByEmail: typeof import("../db/accounts").getAccountByEmail;
let setPriority: typeof import("../db/accounts").setPriority;
let leaseAccount: typeof import("../db/usages").leaseAccount;
let db: typeof import("../db/database").db;

beforeAll(async () => {
  const express = (await import("express")).default;
  const accounts = (await import("../routes/accounts")).default;
  const integration = (await import("../routes/integration")).default;
  ({ upsertAccount, getAccountByEmail, setPriority } = await import("../db/accounts"));
  ({ leaseAccount } = await import("../db/usages"));
  ({ db } = await import("../db/database"));

  const app = express();
  app.use(express.json());
  app.use("/api/accounts", accounts);
  app.use("/api", integration);
  server = app.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

async function post(route: string, body: unknown) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, never> };
}

function account(email: string) {
  return upsertAccount({ email, password: null, clientId: "cid", refreshToken: "rt" });
}

beforeEach(() => {
  db.exec("DELETE FROM account_usages; DELETE FROM accounts");
});

describe("pool priority", () => {
  it("hands out a marked address before the rest of the pool", () => {
    const first = account("plain-a@x.com");
    const second = account("plain-b@x.com");
    const marked = account("marked@x.com");
    setPriority([marked.id], 5);

    expect(leaseAccount("telegram", 60_000)).toMatchObject({
      ok: true,
      account: { email: "marked@x.com" },
    });
    // Then the ordinary rows, still in their own order.
    expect(leaseAccount("telegram", 60_000)).toMatchObject({ account: { id: first.id } });
    expect(leaseAccount("telegram", 60_000)).toMatchObject({ account: { id: second.id } });
  });

  it("orders several marked addresses highest first", () => {
    account("low@x.com");
    const mid = account("mid@x.com");
    const high = account("high@x.com");
    setPriority([mid.id], 1);
    setPriority([high.id], 9);

    expect(leaseAccount("t", 60_000)).toMatchObject({ account: { id: high.id } });
    expect(leaseAccount("t", 60_000)).toMatchObject({ account: { id: mid.id } });
    expect(leaseAccount("t", 60_000)).toMatchObject({ account: { email: "low@x.com" } });
  });

  it("leaves a negative priority behind the ordinary pool", () => {
    const held = account("held@x.com");
    const plain = account("plain@x.com");
    setPriority([held.id], -1);

    expect(leaseAccount("t", 60_000)).toMatchObject({ account: { id: plain.id } });
    expect(leaseAccount("t", 60_000)).toMatchObject({ account: { id: held.id } });
  });

  it("does not hand out a marked address that is disabled or faulty", () => {
    const broken = account("broken@x.com");
    const plain = account("plain@x.com");
    setPriority([broken.id], 9);
    db.prepare("UPDATE accounts SET last_refresh_error = 'bad grant' WHERE id = ?").run(broken.id);

    expect(leaseAccount("t", 60_000)).toMatchObject({ account: { id: plain.id } });
  });
});

describe("POST /accounts/priority", () => {
  it("bumps a selection up and down by delta, and reports the new rows", async () => {
    const a = account("a@x.com");
    const b = account("b@x.com");

    const up = await post("/api/accounts/priority", { ids: [a.id, b.id], delta: 2 });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ updated: 2 });
    expect(getAccountByEmail("a@x.com")?.priority).toBe(2);
    expect(getAccountByEmail("b@x.com")?.priority).toBe(2);

    const down = await post("/api/accounts/priority", { ids: [a.id], delta: -3 });
    expect(down.body).toMatchObject({ updated: 1 });
    expect(getAccountByEmail("a@x.com")?.priority).toBe(-1);
  });

  it("sets one value outright, which is how the reset button works", async () => {
    const a = account("a@x.com");
    setPriority([a.id], 7);

    await post("/api/accounts/priority", { ids: [a.id], priority: 0 });
    expect(getAccountByEmail("a@x.com")?.priority).toBe(0);
  });

  it("clamps instead of running away when the same bump is repeated", async () => {
    const a = account("a@x.com");
    for (let i = 0; i < 3; i++) {
      await post("/api/accounts/priority", { ids: [a.id], delta: 50 });
    }
    expect(getAccountByEmail("a@x.com")?.priority).toBe(99);
  });

  it("rejects a bad selection or a change it cannot read", async () => {
    const a = account("a@x.com");
    expect((await post("/api/accounts/priority", { ids: "all", delta: 1 })).status).toBe(400);
    expect((await post("/api/accounts/priority", { ids: [a.id] })).status).toBe(400);
    expect((await post("/api/accounts/priority", { ids: [a.id], delta: "up" })).status).toBe(400);
  });

  it("carries the priority through the account's public view", async () => {
    const a = account("a@x.com");
    await post("/api/accounts/priority", { ids: [a.id], delta: 4 });

    const response = await fetch(`${base}/api/accounts`);
    const rows = (await response.json()) as { email: string; priority: number }[];
    expect(rows.find((r) => r.email === "a@x.com")?.priority).toBe(4);
  });
});
