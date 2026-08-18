/**
 * Route-level cover for single-message deletion. The transport is stubbed; what is under
 * test is the validation, the credential resolution and the reply shape.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "../types";

const dbFile = path.join(os.tmpdir(), `msapi-delete-${process.pid}.db`);
process.env.DB_PATH = dbFile;

let calls: { mailbox: Mailbox; id: string; email: string }[] = [];
let deleteResult = true;

vi.mock("../middleware/auth", () => ({
  requireApiAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSendAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  getJwtSecret: () => "test-secret",
}));

vi.mock("../services/mail", () => ({
  deleteMessage: async (credentials: { email: string }, mailbox: Mailbox, id: string) => {
    calls.push({ mailbox, id, email: credentials.email });
    return { deleted: deleteResult, transport: "graph" as const, rotatedRefreshToken: null };
  },
  readMail: async () => ({ messages: [], transport: "graph" as const, rotatedRefreshToken: null }),
  purgeMail: async () => ({ deleted: 0, transport: "graph" as const, rotatedRefreshToken: null }),
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const express = (await import("express")).default;
  const mail = (await import("../routes/mail")).default;
  const { upsertAccount } = await import("../db/accounts");

  upsertAccount({ email: "box@x.com", password: null, clientId: "c", refreshToken: "t" });

  const app = express();
  app.use(express.json());
  app.use("/api", mail);
  server = app.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

async function post(body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/delete-mail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, never> };
}

describe("delete-mail", () => {
  beforeEach(() => {
    calls = [];
    deleteResult = true;
  });

  it("deletes the named message from the named folder", async () => {
    const { status, body } = await post({ email: "box@x.com", mailbox: "Junk", id: "AAMk123" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ deleted: true, transport: "graph" });
    expect(calls).toEqual([{ email: "box@x.com", mailbox: "Junk", id: "AAMk123" }]);
  });

  it("reports a miss rather than pretending it deleted something", async () => {
    deleteResult = false;
    const { status, body } = await post({ email: "box@x.com", mailbox: "INBOX", id: "999" });
    expect(status).toBe(200);
    expect(body.deleted).toBe(false);
  });

  it("requires an id", async () => {
    const { status, body } = await post({ email: "box@x.com", mailbox: "INBOX" });
    expect(status).toBe(400);
    expect(body.error).toBe("id is required");
    expect(calls).toHaveLength(0);
  });

  it("rejects a folder outside the two allowed, before reaching the mailbox", async () => {
    const { status } = await post({ email: "box@x.com", mailbox: "Sent Items", id: "1" });
    expect(status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an address with no stored account and no credentials", async () => {
    const { status } = await post({ email: "stranger@x.com", mailbox: "INBOX", id: "1" });
    expect(status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("is not reachable by GET, being destructive", async () => {
    const response = await fetch(`${base}/api/delete-mail?email=box@x.com&mailbox=INBOX&id=1`);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
