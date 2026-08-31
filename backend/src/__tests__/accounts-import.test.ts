/**
 * Route-level cover for the delimited import and export, over real HTTP against a throwaway
 * database.
 *
 * The fifth field is optional: real files carry trailing columns of their own, and an
 * unrecognised one used to fail the whole line. Everything past it is labelled, so an export
 * can carry the whole account back in without a stray column being read as a setting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-import-${process.pid}.db`);
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
let getAccountByEmail: typeof import("../db/accounts").getAccountByEmail;
let updateAccount: typeof import("../db/accounts").updateAccount;

beforeAll(async () => {
  const express = (await import("express")).default;
  const accounts = (await import("../routes/accounts")).default;
  ({ getAccountByEmail, updateAccount } = await import("../db/accounts"));

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

type Report = { imported: number; failed: number; errors: { line: number; reason: string }[] };

async function runImport(body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/accounts/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Report };
}

async function exportLines(): Promise<string[]> {
  const response = await fetch(`${base}/api/accounts/export`);
  return (await response.text()).split("\n").filter(Boolean);
}

/** The exported line for one address, so a test does not depend on the row order. */
async function exportedLine(email: string): Promise<string | undefined> {
  return (await exportLines()).find((line) => line.startsWith(`${email}----`));
}

describe("POST /accounts/import", () => {
  it("defaults a line without a fifth field to auto", async () => {
    const result = await runImport({ content: "four@x.com----pw----cid----rt" });
    expect(result.body).toMatchObject({ imported: 1, failed: 0, errors: [] });
    expect(getAccountByEmail("four@x.com")?.authType).toBe("auto");
  });

  it("reads a fifth field naming a protocol", async () => {
    const result = await runImport({ content: "five@x.com----pw----cid----rt----IMAP" });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    expect(getAccountByEmail("five@x.com")?.authType).toBe("imap");
  });

  it("ignores extra fields instead of failing the line", async () => {
    const result = await runImport({
      content: "extra@x.com----pw----cid----rt----some-note----2024-01-01",
    });
    expect(result.body).toMatchObject({ imported: 1, failed: 0, errors: [] });
    expect(getAccountByEmail("extra@x.com")?.authType).toBe("auto");
  });

  it("falls back to the file-level protocol for a line with no usable fifth field", async () => {
    const result = await runImport({
      content: "filetype@x.com----pw----cid----rt----some-note",
      authType: "imap",
    });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    expect(getAccountByEmail("filetype@x.com")?.authType).toBe("imap");
  });

  it("imports at the normal priority when useFirst is not asked for", async () => {
    const result = await runImport({ content: "normal@x.com----pw----cid----rt" });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    expect(getAccountByEmail("normal@x.com")?.priority).toBe(0);
  });

  it("puts a useFirst file one step above the current top, on one shared rank", async () => {
    await runImport({ content: "top@x.com----pw----cid----rt", useFirst: true });
    expect(getAccountByEmail("top@x.com")?.priority).toBe(1);

    const result = await runImport({
      content: ["first@x.com----pw----cid----rt", "second@x.com----pw----cid----rt"].join("\n"),
      useFirst: true,
    });
    expect(result.body).toMatchObject({ imported: 2, failed: 0 });
    expect(getAccountByEmail("first@x.com")?.priority).toBe(2);
    expect(getAccountByEmail("second@x.com")?.priority).toBe(2);
  });

  it("leaves the priority of a re-imported account alone without useFirst", async () => {
    await runImport({ content: "keep@x.com----pw----cid----rt", useFirst: true });
    const before = getAccountByEmail("keep@x.com")?.priority;
    expect(before).toBeGreaterThan(0);

    await runImport({ content: "keep@x.com----pw----cid----rt2" });
    expect(getAccountByEmail("keep@x.com")?.priority).toBe(before);
  });

  it("takes useFirst over a priority written in the file", async () => {
    await runImport({ content: "beats@x.com----pw----cid----rt----auto----priority=3" });
    expect(getAccountByEmail("beats@x.com")?.priority).toBe(3);

    const result = await runImport({
      content: "beats@x.com----pw----cid----rt----auto----priority=3",
      useFirst: true,
    });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    expect(getAccountByEmail("beats@x.com")?.priority).toBeGreaterThan(3);
  });

  it("reads labelled remark and disabled fields", async () => {
    const result = await runImport({
      content: "labelled@x.com----pw----cid----rt----imap----remark=bought monday----disabled=1",
    });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    const account = getAccountByEmail("labelled@x.com");
    expect(account).toMatchObject({ authType: "imap", remark: "bought monday", disabled: true });
  });

  it("ignores an unlabelled trailing number instead of reading it as a priority", async () => {
    const result = await runImport({ content: "stray@x.com----pw----cid----rt----note----7" });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    expect(getAccountByEmail("stray@x.com")?.priority).toBe(0);
  });

  it("leaves a disabled account off when the line says nothing about it", async () => {
    await runImport({ content: "off@x.com----pw----cid----rt----auto----disabled=1" });
    await runImport({ content: "off@x.com----pw----cid----rt2" });
    expect(getAccountByEmail("off@x.com")?.disabled).toBe(true);
  });

  it("rejects a non-boolean useFirst", async () => {
    const result = await runImport({ content: "bad@x.com----pw----cid----rt", useFirst: "yes" });
    expect(result.status).toBe(400);
    expect(getAccountByEmail("bad@x.com")).toBeUndefined();
  });

  it("still rejects a line short of four fields", async () => {
    const result = await runImport({ content: "short@x.com----pw----cid" });
    expect(result.body.imported).toBe(0);
    expect(result.body.errors[0]?.reason).toContain("expected 4 fields");
  });
});

describe("GET /accounts/export", () => {
  it("writes the plain five fields for an account sitting on the defaults", async () => {
    await runImport({ content: "plain@x.com----pw----cid----rt" });
    expect(await exportedLine("plain@x.com")).toBe("plain@x.com----pw----cid----rt----auto");
  });

  it("round-trips priority, remark and disabled through an import", async () => {
    await runImport({ content: "trip@x.com----pw----cid----rt----imap" });
    const id = getAccountByEmail("trip@x.com")!.id;
    updateAccount(id, { priority: 4, remark: "keep me", disabled: true });

    const line = await exportedLine("trip@x.com");
    expect(line).toContain("priority=4");
    expect(line).toContain("remark=keep me");
    expect(line).toContain("disabled=1");

    // Back to the defaults, so the re-import has to be what puts the settings back.
    updateAccount(id, { priority: 0, remark: "", disabled: false });
    const result = await runImport({ content: line });
    expect(result.body).toMatchObject({ imported: 1, failed: 0 });
    expect(getAccountByEmail("trip@x.com")).toMatchObject({
      authType: "imap",
      priority: 4,
      remark: "keep me",
      disabled: true,
    });
  });

  it("flattens a remark holding the delimiter so the line still parses", async () => {
    await runImport({ content: "flat@x.com----pw----cid----rt" });
    updateAccount(getAccountByEmail("flat@x.com")!.id, { remark: "a----b\nc" });

    const line = await exportedLine("flat@x.com");
    expect(line).toContain("remark=a b c");

    const result = await runImport({ content: line });
    expect(result.body).toMatchObject({ imported: 1, failed: 0, errors: [] });
    expect(getAccountByEmail("flat@x.com")?.remark).toBe("a b c");
  });
});
