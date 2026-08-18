/**
 * Transport selection by auth type. Graph, IMAP and the token endpoint are all stubbed;
 * what is under test is which of them each kind of account is made to talk to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailCredentials } from "../services/mail";

const graphProbes: string[] = [];
const imapTokenCalls: string[] = [];
const mailTokenCalls: string[] = [];

let graphAvailable = true;
/** When set, probeGraphAccess throws it instead of answering. */
let probeThrows: { consent: boolean } | null = null;

vi.mock("../services/oauth", () => ({
  probeGraphAccess: async (refreshToken: string) => {
    graphProbes.push(refreshToken);
    if (probeThrows) throw probeThrows;
    return { available: graphAvailable, accessToken: "graph-token", refreshToken: "rolled-graph" };
  },
  getImapAccessToken: async (refreshToken: string) => {
    imapTokenCalls.push(refreshToken);
    return { accessToken: "imap-scoped-token", refreshToken: "rolled-imap", scope: "" };
  },
  getMailAccessToken: async (refreshToken: string) => {
    mailTokenCalls.push(refreshToken);
    return { accessToken: "default-token", refreshToken: "rolled-default", scope: "" };
  },
  isGraphConsentFailure: (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as { consent?: boolean }).consent),
}));

const graphCalls: string[] = [];
const imapCalls: { email: string; accessToken: string }[] = [];

vi.mock("../services/graph", () => ({
  listMessages: async (accessToken: string) => {
    graphCalls.push(accessToken);
    return [];
  },
  deleteMessage: async () => undefined,
  purgeFolder: async () => ({ deleted: 0 }),
}));

vi.mock("../services/imap", () => ({
  fetchMessages: async (email: string, accessToken: string) => {
    imapCalls.push({ email, accessToken });
    return [];
  },
  deleteMessage: async () => true,
  purgeFolder: async () => ({ deleted: 0 }),
}));

const account = (authType?: "auto" | "imap"): MailCredentials => ({
  email: "box@x.com",
  clientId: "cid",
  refreshToken: "rt",
  ...(authType ? { authType } : {}),
});

describe("transport selection by auth type", () => {
  beforeEach(() => {
    graphProbes.length = 0;
    imapTokenCalls.length = 0;
    mailTokenCalls.length = 0;
    graphCalls.length = 0;
    imapCalls.length = 0;
    graphAvailable = true;
    probeThrows = null;
  });

  it("sends an imap account straight to IMAP without probing Graph", async () => {
    const { readMail } = await import("../services/mail");
    const result = await readMail(account("imap"), "INBOX", 10);

    expect(graphProbes).toEqual([]);
    expect(imapTokenCalls).toEqual(["rt"]);
    expect(imapCalls).toEqual([{ email: "box@x.com", accessToken: "imap-scoped-token" }]);
    expect(result.transport).toBe("imap");
  });

  it("uses the IMAP-scoped grant, not the default one", async () => {
    const { readMail } = await import("../services/mail");
    await readMail(account("imap"), "INBOX", 10);

    expect(mailTokenCalls).toEqual([]);
  });

  it("still probes Graph first for an auto account", async () => {
    const { readMail } = await import("../services/mail");
    const result = await readMail(account("auto"), "INBOX", 10);

    expect(graphProbes).toEqual(["rt"]);
    expect(graphCalls).toEqual(["graph-token"]);
    expect(result.transport).toBe("graph");
  });

  it("treats credentials with no auth type as auto, as callers predating the field expect", async () => {
    const { readMail } = await import("../services/mail");
    const result = await readMail(account(), "INBOX", 10);

    expect(graphProbes).toEqual(["rt"]);
    expect(result.transport).toBe("graph");
  });

  it("keeps the existing IMAP fallback for an auto account Graph will not serve", async () => {
    graphAvailable = false;
    const { readMail } = await import("../services/mail");
    const result = await readMail(account("auto"), "INBOX", 10);

    // The fallback stays on the default grant: that is what these accounts have always
    // used, and the IMAP scope is only for consent that never covered Graph.
    expect(mailTokenCalls).toEqual(["rt"]);
    expect(imapTokenCalls).toEqual([]);
    expect(result.transport).toBe("imap");
  });

  it("falls back to IMAP when an auto account has no Graph consent at all", async () => {
    // The probe throws rather than reporting unavailable: the account was never consented to
    // Graph, so the .default request is rejected outright.
    probeThrows = { consent: true };
    const { readMail } = await import("../services/mail");
    const result = await readMail(account("auto"), "INBOX", 10);

    expect(graphProbes).toEqual(["rt"]);
    expect(mailTokenCalls).toEqual(["rt"]);
    expect(result.transport).toBe("imap");
  });

  it("rethrows a probe failure that is not a Graph consent problem", async () => {
    // A dead token, say: falling back to IMAP would only hide the real reason.
    probeThrows = { consent: false };
    const { readMail } = await import("../services/mail");

    await expect(readMail(account("auto"), "INBOX", 10)).rejects.toBe(probeThrows);
    expect(mailTokenCalls).toEqual([]);
  });

  it("returns the rolled token from whichever grant was used", async () => {
    const { readMail } = await import("../services/mail");

    expect((await readMail(account("imap"), "INBOX", 10)).rotatedRefreshToken).toBe("rolled-imap");
    expect((await readMail(account("auto"), "INBOX", 10)).rotatedRefreshToken).toBe("rolled-graph");
  });

  it("reads every folder over the one transport it opened", async () => {
    const { readFolders } = await import("../services/mail");
    const result = await readFolders(account("imap"), ["INBOX", "Junk"], 5);

    // One token for both folders, not one per folder.
    expect(imapTokenCalls).toEqual(["rt"]);
    expect(imapCalls).toHaveLength(2);
    expect(result.transport).toBe("imap");
  });
});
