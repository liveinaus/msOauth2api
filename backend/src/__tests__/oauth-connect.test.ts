/**
 * Route-level cover for the connect-mailbox flow: what /start builds, and what /callback
 * does with the code. The token endpoint is stubbed, so nothing here talks to Microsoft.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbFile = path.join(os.tmpdir(), `msapi-oauth-routes-${process.pid}.db`);
process.env.DB_PATH = dbFile;

vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApiAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSendAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  getJwtSecret: () => "test-secret",
}));

/** A token response of the shape Microsoft returns, with an id_token for `email`. */
const tokenResponse = vi.fn();

vi.mock("../services/http", () => ({
  fetchWithTimeout: async () => tokenResponse(),
}));

function idToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ preferred_username: email })).toString("base64url");
  return `header.${payload}.signature`;
}

function okToken(email: string, refreshToken = "rt-fresh") {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        access_token: "at",
        refresh_token: refreshToken,
        scope: "https://graph.microsoft.com/Mail.ReadWrite",
        id_token: idToken(email),
      }),
  };
}

let server: Server;
let base: string;
let getAccountByEmail: typeof import("../db/accounts").getAccountByEmail;
let resetFlows: typeof import("../auth/oauthFlowStore").resetFlows;
let savePanelSettings: typeof import("../db/panelSettings").savePanelSettings;

beforeAll(async () => {
  const express = (await import("express")).default;
  const oauth = (await import("../routes/oauth")).default;
  ({ getAccountByEmail } = await import("../db/accounts"));
  ({ resetFlows } = await import("../auth/oauthFlowStore"));
  ({ savePanelSettings } = await import("../db/panelSettings"));

  const app = express();
  app.use(express.json());
  app.use("/api/oauth", oauth);
  server = app.listen(0);
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

beforeEach(() => {
  resetFlows();
  tokenResponse.mockReset();
  delete process.env.OAUTH_CLIENT_ID;
  savePanelSettings({ oauthClientId: "", oauthRedirectUri: "" });
});

async function start(body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/oauth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function callback(query: string) {
  const response = await fetch(`${base}/api/oauth/callback?${query}`, { redirect: "manual" });
  return { status: response.status, html: await response.text() };
}

/** Runs /start and returns the state, which is what the callback is keyed on. */
async function stateFor(email: string, extra: Record<string, unknown> = {}) {
  const started = await start({
    email,
    clientId: "cid-123",
    redirectUri: "https://panel.example.com/api/oauth/callback",
    ...extra,
  });
  expect(started.status).toBe(200);
  return started.body.state as string;
}

describe("POST /api/oauth/start", () => {
  it("builds an authorize URL carrying PKCE, the state and the login hint", async () => {
    const { body } = await start({
      email: "a@b.com",
      clientId: "cid-123",
      redirectUri: "https://panel.example.com/api/oauth/callback",
    });
    const url = new URL(body.authorizeUrl);

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("state")).toBe(body.state);
    expect(url.searchParams.get("login_hint")).toBe("a@b.com");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("never puts the PKCE verifier in the response", async () => {
    const { body } = await start({ email: "a@b.com", clientId: "cid-123" });
    expect(JSON.stringify(body)).not.toContain("code_verifier");
    expect(body.verifier).toBeUndefined();
  });

  it("asks for the Outlook scopes when the account is marked imap", async () => {
    const { body } = await start({ email: "a@b.com", clientId: "cid-123", authType: "imap" });
    const scope = new URL(body.authorizeUrl).searchParams.get("scope") ?? "";
    expect(scope).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(scope).toContain("https://outlook.office.com/SMTP.Send");
    expect(scope).not.toContain("graph.microsoft.com");
  });

  it("falls back to the client id stored in settings, then to the environment", async () => {
    expect((await start({ email: "a@b.com" })).status).toBe(400);

    savePanelSettings({ oauthClientId: "cid-from-settings" });
    let { body } = await start({ email: "a@b.com" });
    expect(new URL(body.authorizeUrl).searchParams.get("client_id")).toBe("cid-from-settings");

    savePanelSettings({ oauthClientId: "" });
    process.env.OAUTH_CLIENT_ID = "cid-from-env";
    ({ body } = await start({ email: "a@b.com" }));
    expect(new URL(body.authorizeUrl).searchParams.get("client_id")).toBe("cid-from-env");
  });

  it("rejects a plain http redirect URI outside loopback", async () => {
    const { status, body } = await start({
      email: "a@b.com",
      clientId: "cid-123",
      redirectUri: "http://ports.example.com:54444/ms/callback",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("https");
  });
});

describe("GET /api/oauth/callback", () => {
  it("stores the account, so no import is needed", async () => {
    const state = await stateFor("new@example.com");
    tokenResponse.mockReturnValue(okToken("new@example.com"));

    const { status, html } = await callback(`code=the-code&state=${state}`);
    expect(status).toBe(200);
    expect(html).toContain("Mailbox connected");

    const stored = getAccountByEmail("new@example.com");
    expect(stored?.refreshToken).toBe("rt-fresh");
    expect(stored?.clientId).toBe("cid-123");
  });

  it("updates an address it already holds rather than duplicating it", async () => {
    tokenResponse.mockReturnValue(okToken("dupe@example.com", "rt-one"));
    await callback(`code=c1&state=${await stateFor("dupe@example.com")}`);
    const first = getAccountByEmail("dupe@example.com");

    tokenResponse.mockReturnValue(okToken("dupe@example.com", "rt-two"));
    await callback(`code=c2&state=${await stateFor("dupe@example.com")}`);
    const second = getAccountByEmail("dupe@example.com");

    expect(second?.id).toBe(first?.id);
    expect(second?.refreshToken).toBe("rt-two");
  });

  it("stores nothing when a different mailbox signed in", async () => {
    const state = await stateFor("wanted@example.com");
    tokenResponse.mockReturnValue(okToken("someone-else@example.com"));

    const { status, html } = await callback(`code=the-code&state=${state}`);
    expect(status).toBe(409);
    expect(html).toContain("different mailbox");
    expect(getAccountByEmail("wanted@example.com")).toBeUndefined();
  });

  it("burns the state, so a code cannot be replayed", async () => {
    const state = await stateFor("once@example.com");
    tokenResponse.mockReturnValue(okToken("once@example.com"));

    expect((await callback(`code=c&state=${state}`)).status).toBe(200);
    const replay = await callback(`code=c&state=${state}`);
    expect(replay.status).toBe(400);
    expect(replay.html).toContain("no longer valid");
  });

  it("rejects a state it never issued", async () => {
    const { status } = await callback("code=c&state=made-up");
    expect(status).toBe(400);
    expect(tokenResponse).not.toHaveBeenCalled();
  });

  it("reports a rejected code without storing anything", async () => {
    const state = await stateFor("bad@example.com");
    tokenResponse.mockReturnValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant", error_codes: [70000] }),
    });

    const { status, html } = await callback(`code=expired&state=${state}`);
    expect(status).toBe(502);
    expect(html).toContain("invalid_grant");
    expect(getAccountByEmail("bad@example.com")).toBeUndefined();
  });

  it("shows the error when the user declines consent", async () => {
    const { status, html } = await callback("error=access_denied&error_description=user+cancelled");
    expect(status).toBe(400);
    expect(html).toContain("access_denied");
  });

  it("escapes what Microsoft sends back, so the page cannot be injected into", async () => {
    const { html } = await callback("error=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
