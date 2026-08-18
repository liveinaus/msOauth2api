/**
 * Route-level cover for the backup endpoints: the passphrase gate on export, and the
 * decryption path on import. Runs against a throwaway database with the auth guard stubbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-backup-routes-${process.pid}.db`);
process.env.DB_PATH = dbFile;

vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApiAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSendAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  getJwtSecret: () => "test-secret",
}));

const PASSPHRASE = "a-long-enough-passphrase";

let server: Server;
let base: string;
let getAccountByEmail: typeof import("../db/accounts").getAccountByEmail;

beforeAll(async () => {
  const express = (await import("express")).default;
  const backup = (await import("../routes/backup")).default;
  const { upsertAccount } = await import("../db/accounts");
  ({ getAccountByEmail } = await import("../db/accounts"));

  upsertAccount({
    email: "kept@example.com",
    password: "mailbox-password",
    clientId: "cid",
    refreshToken: "rt-very-secret",
  });

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/api/backup", backup);
  server = app.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

async function post(route: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/backup/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: (() => {
      try {
        return JSON.parse(text) as Record<string, never>;
      } catch {
        return {} as Record<string, never>;
      }
    })(),
    disposition: response.headers.get("content-disposition") ?? "",
  };
}

describe("backup export", () => {
  it("refuses to write a plain-text file unless that is stated outright", async () => {
    const { status, json } = await post("export", {});
    expect(status).toBe(400);
    expect(json.error).toMatch(/unencrypted/i);
  });

  it("writes a plain file when the caller accepts that", async () => {
    const { status, text, disposition } = await post("export", { unprotected: true });
    expect(status).toBe(200);
    expect(disposition).not.toContain("protected");
    // The whole point of the warning: the secrets really are readable in it.
    expect(text).toContain("rt-very-secret");
    expect(text).toContain("mailbox-password");
  });

  it("encrypts under a passphrase, leaving no secret in the file", async () => {
    const { status, text, disposition } = await post("export", { passphrase: PASSPHRASE });
    expect(status).toBe(200);
    expect(disposition).toContain("protected");
    expect(text).not.toContain("rt-very-secret");
    expect(text).not.toContain("mailbox-password");
    expect(text).not.toContain("kept@example.com");
    expect(JSON.parse(text).format).toBe("msoauth2api.backup.encrypted");
  });

  it("rejects a passphrase too short to protect anything", async () => {
    const { status, json } = await post("export", { passphrase: "short" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/at least 8/);
  });
});

describe("backup import", () => {
  async function sealedBackup() {
    const { text } = await post("export", { passphrase: PASSPHRASE });
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("restores an encrypted file given its passphrase", async () => {
    const document = await sealedBackup();
    const { status, json } = await post("import", {
      backup: document,
      passphrase: PASSPHRASE,
      mode: "replace",
    });

    expect(status).toBe(200);
    expect(json.accounts).toBe(1);
    expect(getAccountByEmail("kept@example.com")?.refreshToken).toBe("rt-very-secret");
  });

  it("asks for the passphrase when the file is protected and none was sent", async () => {
    const { status, json } = await post("import", { backup: await sealedBackup() });
    expect(status).toBe(400);
    expect(json.error).toMatch(/protected/i);
  });

  it("rejects the wrong passphrase without touching the data", async () => {
    const { status, json } = await post("import", {
      backup: await sealedBackup(),
      passphrase: "not-the-passphrase",
      mode: "replace",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Wrong passphrase/);
    expect(getAccountByEmail("kept@example.com")).toBeDefined();
  });

  it("still takes a plain file, for a backup made without one", async () => {
    const { text } = await post("export", { unprotected: true });
    const { status, json } = await post("import", { backup: JSON.parse(text), mode: "merge" });
    expect(status).toBe(200);
    expect(json.accounts).toBe(1);
  });
});
