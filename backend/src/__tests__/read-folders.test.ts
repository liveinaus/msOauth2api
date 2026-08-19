/**
 * Reading inbox and junk together. The transports are stubbed; what is under test is what
 * happens to the call when one folder answers and the other does not -- the case that used
 * to throw away a code that had already been found.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailbox, MailMessage } from "../types";

vi.mock("../services/oauth", () => ({
  probeGraphAccess: async () => ({ available: false, accessToken: "g", refreshToken: null }),
  getImapAccessToken: async () => ({ accessToken: "t", refreshToken: null, scope: "" }),
  getMailAccessToken: async () => ({ accessToken: "t", refreshToken: null, scope: "" }),
  isGraphConsentFailure: () => false,
}));

vi.mock("../services/graph", () => ({
  listMessages: async () => [],
  deleteMessage: async () => undefined,
  purgeFolder: async () => ({ deleted: 0 }),
}));

const fetchMessages = vi.fn();

vi.mock("../services/imap", () => ({
  fetchMessages: (...args: unknown[]) => fetchMessages(...args),
  deleteMessage: async () => true,
  purgeFolder: async () => ({ deleted: 0 }),
}));

const { readFolders } = await import("../services/mail");

const credentials = { email: "box@x.com", clientId: "cid", refreshToken: "rt" };

function message(subject: string): MailMessage {
  return { send: "a@b.com", subject, text: "", html: "", date: "2026-08-13T10:00:00Z" };
}

beforeEach(() => {
  fetchMessages.mockReset();
});

describe("readFolders", () => {
  it("returns what the inbox held even when junk could not be read", async () => {
    fetchMessages.mockImplementation(async (_email: string, _token: string, mailbox: Mailbox) => {
      if (mailbox === "Junk") throw new Error("junk timed out");
      return [message("code inside")];
    });

    const result = await readFolders(credentials, ["INBOX", "Junk"], 10);
    expect(result.messages.map((m) => m.subject)).toEqual(["code inside"]);
  });

  it("throws when no folder could be read at all", async () => {
    fetchMessages.mockRejectedValue(new Error("mailbox unreachable"));

    await expect(readFolders(credentials, ["INBOX", "Junk"], 10)).rejects.toThrow(
      "mailbox unreachable",
    );
  });
});
