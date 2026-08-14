/**
 * Route-level cover for the address-pool API, over real HTTP against a throwaway database.
 * Only the mail transport and the API-key guard are stubbed; the pool logic is the real one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderMessage } from "../services/mail";

const dbFile = path.join(os.tmpdir(), `msapi-integration-${process.pid}.db`);
process.env.DB_PATH = dbFile;

let folderMessages: FolderMessage[] = [];

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
    messages: folderMessages,
  }),
  // The accounts router imports this too, and a name missing from a mock fails at link time.
  pickForPanel: (messages: FolderMessage[]) => messages.find((m) => m.code) ?? messages[0] ?? null,
}));

let server: Server;
let base: string;
let upsertAccount: typeof import("../db/accounts").upsertAccount;
let getUsage: typeof import("../db/usages").getUsage;
let leaseAccount: typeof import("../db/usages").leaseAccount;
let getAccountByEmail: typeof import("../db/accounts").getAccountByEmail;

beforeAll(async () => {
  const express = (await import("express")).default;
  const integration = (await import("../routes/integration")).default;
  const accounts = (await import("../routes/accounts")).default;
  const types = (await import("../routes/types")).default;
  ({ upsertAccount, getAccountByEmail } = await import("../db/accounts"));
  ({ getUsage, leaseAccount } = await import("../db/usages"));

  const app = express();
  app.use(express.json());
  app.use("/api", integration);
  app.use("/api/accounts", accounts);
  app.use("/api/types", types);

  server = app.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

async function call(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: (await response.json()) as Record<string, never> };
}

function codeMail(overrides: Partial<FolderMessage> = {}): FolderMessage {
  return {
    send: "noreply@telegram.org",
    subject: "Login code",
    text: "code 483920",
    html: "",
    date: new Date(Date.now() + 1000).toISOString(),
    code: "483920",
    mailbox: "Junk",
    ...overrides,
  };
}

describe("address pool API", () => {
  beforeEach(() => {
    folderMessages = [codeMail()];
  });

  it("rejects a handout with no type", async () => {
    const { status, body } = await call("/api/get-available-email");
    expect(status).toBe(400);
    expect(body.error).toBe("type is required");
  });

  it("leases an address, and never the same one twice while the lease stands", async () => {
    upsertAccount({ email: "pool1@x.com", password: null, clientId: "c", refreshToken: "t" });
    upsertAccount({ email: "pool2@x.com", password: null, clientId: "c", refreshToken: "t" });

    const first = await call("/api/get-available-email?type=Telegram");
    const second = await call("/api/get-available-email?type=Telegram");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.email).not.toBe(second.body.email);
    expect(first.body.type).toBe("telegram");
  });

  it("answers 409 with counts once the pool for that type is spent", async () => {
    const { status, body } = await call("/api/get-available-email?type=Telegram");
    expect(status).toBe(409);
    expect(body).toMatchObject({ available: 0, leased: 2, confirmed: 0 });
  });

  it("keeps types independent of one another", async () => {
    const { status, body } = await call("/api/get-available-email?type=Discord");
    expect(status).toBe(200);
    expect(body.email).toBe("pool1@x.com");
  });

  it("returns the code and retires the address for that type", async () => {
    const { status, body } = await call(
      "/api/get-code?email=pool1@x.com&type=Telegram&from=telegram",
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "found", code: "483920" });
    expect(body.message).toMatchObject({ mailbox: "Junk", from: "noreply@telegram.org" });

    const account = getAccountByEmail("pool1@x.com")!;
    expect(getUsage(account.id, "telegram")?.confirmedAt).toBeGreaterThan(0);
  });

  it("reports pending, not an error, when the filters exclude everything", async () => {
    const { status, body } = await call(
      "/api/get-code?email=pool2@x.com&type=Telegram&from=discord",
    );
    expect(status).toBe(200);
    expect(body.status).toBe("pending");
  });

  it("ignores a code that predates the lease", async () => {
    folderMessages = [codeMail({ date: "2020-01-01T00:00:00Z" })];
    const { body } = await call("/api/get-code?email=pool2@x.com&type=Telegram");
    expect(body.status).toBe("pending");
  });

  it("honours an explicit since over the lease window", async () => {
    folderMessages = [codeMail({ date: "2020-01-01T00:00:00Z" })];
    const { body } = await call("/api/get-code?email=pool2@x.com&type=Telegram&since=1");
    expect(body).toMatchObject({ status: "found", code: "483920" });
  });

  it("404s for an address that is not a stored account", async () => {
    const { status } = await call("/api/get-code?email=stranger@x.com");
    expect(status).toBe(404);
  });

  it("releases a leased address but leaves a confirmed one retired", async () => {
    // A type of its own: pool1 and pool2 are both confirmed for Telegram by now, and a
    // confirmed row is exactly what must not be released.
    const fresh = await call("/api/get-available-email?type=ReleaseCheck");
    const leased = await call("/api/release-email", {
      method: "POST",
      body: JSON.stringify({ email: fresh.body.email, type: "ReleaseCheck" }),
    });
    expect(leased.body.released).toBe(true);

    const confirmed = await call("/api/release-email", {
      method: "POST",
      body: JSON.stringify({ email: "pool1@x.com", type: "Telegram" }),
    });
    expect(confirmed.body.released).toBe(false);
  });

  it("reports what an address has been used for", async () => {
    const { body } = await call("/api/email-status?email=pool1@x.com");
    expect(body.email).toBe("pool1@x.com");
    expect(body.usages).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "telegram", code: "483920" })]),
    );
  });
});

describe("type configuration", () => {
  it("rejects a name with characters that would not survive a query string", async () => {
    const { status, body } = await call("/api/types", {
      method: "POST",
      body: JSON.stringify({ name: "tele/gram?x" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name may use/);
  });

  it("rejects a pattern that will not compile, rather than saving a dead filter", async () => {
    const { status, body } = await call("/api/types", {
      method: "POST",
      body: JSON.stringify({ name: "broken", codePattern: "([0-9]{3}" }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not a valid regular expression/);
  });

  it("creates a type, normalising its name, and refuses a duplicate", async () => {
    const created = await call("/api/types", {
      method: "POST",
      body: JSON.stringify({
        name: "  Telegram ",
        fromFilter: "telegram.org",
        codePattern: "code:?\\s*(\\d{5,6})",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("telegram");

    const again = await call("/api/types", {
      method: "POST",
      body: JSON.stringify({ name: "telegram" }),
    });
    expect(again.status).toBe(409);
  });

  it("uses the type's own pattern and sender filter for get-code", async () => {
    folderMessages = [
      codeMail({
        send: "noreply@telegram.org",
        subject: "Telegram",
        text: "Your login code: 55123",
        code: undefined,
      }),
    ];
    upsertAccount({ email: "typed@x.com", password: null, clientId: "c", refreshToken: "t" });

    // No from= or subject= arguments: they come from the stored type.
    const { body } = await call("/api/get-code?email=typed@x.com&type=telegram");
    expect(body).toMatchObject({ status: "found", code: "55123" });
  });

  it("does not report a code from mail the type's sender filter excludes", async () => {
    folderMessages = [
      codeMail({ send: "noreply@other.com", text: "Your login code: 55123", code: undefined }),
    ];
    upsertAccount({ email: "typed2@x.com", password: null, clientId: "c", refreshToken: "t" });

    const { body } = await call("/api/get-code?email=typed2@x.com&type=telegram");
    expect(body.status).toBe("pending");
  });
});

describe("per-type marking from the panel", () => {
  type Row = { email: string; lastUsedAt: number | null; usages: { type: string }[] };

  it("scopes a copy to the type, leaving the account-wide dates alone", async () => {
    const account = upsertAccount({
      email: "scoped@x.com",
      password: null,
      clientId: "c",
      refreshToken: "t",
    });

    const { status } = await call(`/api/accounts/${account.id}/copied`, {
      method: "POST",
      body: JSON.stringify({ type: "telegram" }),
    });
    expect(status).toBe(200);

    const fresh = getAccountByEmail("scoped@x.com")!;
    expect(fresh.lastCopiedAt).toBeNull();
    expect(fresh.lastUsedAt).toBeNull();
    expect(getUsage(fresh.id, "telegram")?.leasedAt).toBeGreaterThan(0);
  });

  it("still moves the account-wide dates when no type is given", async () => {
    const account = getAccountByEmail("scoped@x.com")!;
    await call(`/api/accounts/${account.id}/copied`, { method: "POST", body: "{}" });
    expect(getAccountByEmail("scoped@x.com")!.lastCopiedAt).toBeGreaterThan(0);
  });

  it("marks and unmarks a type by hand", async () => {
    const account = getAccountByEmail("scoped@x.com")!;

    const marked = await call(`/api/accounts/${account.id}/usage`, {
      method: "POST",
      body: JSON.stringify({ type: "Microsoft", used: true }),
    });
    expect(marked.status).toBe(200);
    expect(getUsage(account.id, "microsoft")?.confirmedAt).toBeGreaterThan(0);

    await call(`/api/accounts/${account.id}/usage`, {
      method: "POST",
      body: JSON.stringify({ type: "Microsoft", used: false }),
    });
    expect(getUsage(account.id, "microsoft")).toBeUndefined();
  });

  it("requires a type when marking by hand", async () => {
    const account = getAccountByEmail("scoped@x.com")!;
    const { status } = await call(`/api/accounts/${account.id}/usage`, {
      method: "POST",
      body: JSON.stringify({ used: true }),
    });
    expect(status).toBe(400);
  });
});

describe("type matching is case-insensitive", () => {
  it("treats every spelling as one type, and answers in the normalised one", async () => {
    upsertAccount({ email: "case@x.com", password: null, clientId: "c", refreshToken: "t" });

    // Leased with padding and mixed case.
    const lease = await call("/api/get-available-email?type=%20CaseTest%20");
    expect(lease.status).toBe(200);
    expect(lease.body.type).toBe("casetest");

    // Found again under a different spelling.
    const status = await call(`/api/email-status?email=${lease.body.email}&type=CASETEST`);
    expect(status.body.usages).toHaveLength(1);

    const pool = await call("/api/pool-status?type=casetest");
    expect(pool.body).toMatchObject({ type: "casetest", leased: 1 });

    // And released by a third.
    const released = await call("/api/release-email", {
      method: "POST",
      body: JSON.stringify({ email: lease.body.email, type: "CaseTEST" }),
    });
    expect(released.body).toMatchObject({ released: true, type: "casetest" });
  });

  it("reaches a configured type's rules whatever case the caller sends", async () => {
    folderMessages = [
      codeMail({
        send: "noreply@telegram.org",
        text: "Your login code: 66123",
        code: undefined,
      }),
    ];
    upsertAccount({ email: "case2@x.com", password: null, clientId: "c", refreshToken: "t" });

    // The stored type is "telegram"; the caller shouts.
    const { body } = await call("/api/get-code?email=case2@x.com&type=TELEGRAM");
    expect(body).toMatchObject({ status: "found", code: "66123", type: "telegram" });
    expect(getUsage(getAccountByEmail("case2@x.com")!.id, "TeLeGrAm")?.confirmedAt).toBeGreaterThan(
      0,
    );
  });

  it("scopes a panel copy to the same type regardless of case", async () => {
    const account = upsertAccount({
      email: "case3@x.com",
      password: null,
      clientId: "c",
      refreshToken: "t",
    });

    await call(`/api/accounts/${account.id}/copied`, {
      method: "POST",
      body: JSON.stringify({ type: "  TeleGram " }),
    });
    expect(getUsage(account.id, "telegram")?.leasedAt).toBeGreaterThan(0);
  });
});

describe("accounts list", () => {
  type Row = { email: string; usages: { type: string; confirmedAt: number | null }[] };

  it("carries the types each address has been used for", async () => {
    const { body } = await call("/api/accounts");
    const rows = body as unknown as Row[];
    const pool1 = rows.find((r) => r.email === "pool1@x.com");

    expect(pool1?.usages.map((u) => u.type).sort()).toEqual(["discord", "telegram"]);
    expect(pool1?.usages.find((u) => u.type === "telegram")?.confirmedAt).toBeGreaterThan(0);
  });

  it("shows a live lease but drops an expired one, which is back in the pool", async () => {
    const live = leaseAccount("Live", 60_000);
    const lapsed = leaseAccount("Lapsed", -1000);
    expect(live.ok && lapsed.ok).toBe(true);
    if (!live.ok || !lapsed.ok) return;

    const { body } = await call("/api/accounts");
    const rows = body as unknown as Row[];

    const liveRow = rows.find((r) => r.email === live.account.email);
    expect(liveRow?.usages.find((u) => u.type === "live")).toMatchObject({ confirmedAt: null });

    const lapsedRow = rows.find((r) => r.email === lapsed.account.email);
    expect(lapsedRow?.usages.some((u) => u.type === "lapsed")).toBe(false);
  });
});
