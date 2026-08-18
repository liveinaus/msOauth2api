/**
 * Route-level cover for send-mail: which OAuth grant the token comes from per auth type.
 * An imap account must send on an SMTP.Send token, not its IMAP read token, or Outlook
 * answers 535. Both oauth and smtp are stubbed; what is under test is that selection.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-send-${process.pid}.db`);
process.env.DB_PATH = dbFile;

let smtpTokens: string[] = [];

vi.mock("../middleware/auth", () => ({
  requireApiAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSendAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  getJwtSecret: () => "test-secret",
}));

vi.mock("../services/oauth", () => ({
  OAuthError: class extends Error {},
  refreshScopeFor: () => undefined,
  exchangeRefreshToken: async () => ({ accessToken: "x", refreshToken: null, scope: "" }),
  getMailAccessToken: async () => ({ accessToken: "mail-token", refreshToken: null, scope: "" }),
  getSmtpAccessToken: async () => ({ accessToken: "smtp-token", refreshToken: null, scope: "" }),
}));

vi.mock("../services/smtp", () => ({
  sendMail: async (input: { accessToken: string }) => {
    smtpTokens.push(input.accessToken);
    return { messageId: "<id@test>" };
  },
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const express = (await import("express")).default;
  const mail = (await import("../routes/mail")).default;
  const { upsertAccount } = await import("../db/accounts");

  upsertAccount({ email: "auto@x.com", password: null, clientId: "c", refreshToken: "t" });
  upsertAccount({
    email: "imap@x.com",
    password: null,
    clientId: "c",
    refreshToken: "t",
    authType: "imap",
  });

  const app = express();
  app.use(express.json());
  app.use("/api", mail);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(`${dbFile}-shm`, { force: true });
  fs.rmSync(`${dbFile}-wal`, { force: true });
});

beforeEach(() => {
  smtpTokens = [];
});

async function send(email: string) {
  return fetch(`${base}/api/send-mail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, to: "dest@x.com", subject: "hi", text: "body" }),
  });
}

describe("send-mail token selection", () => {
  it("sends an imap account on an SMTP.Send token, not its IMAP read token", async () => {
    const res = await send("imap@x.com");
    expect(res.status).toBe(200);
    expect(smtpTokens).toEqual(["smtp-token"]);
  });

  it("sends an auto account on the default grant, as before", async () => {
    const res = await send("auto@x.com");
    expect(res.status).toBe(200);
    expect(smtpTokens).toEqual(["mail-token"]);
  });
});
