/**
 * The failure that took the process down: imapflow reports post-connect faults by emitting
 * 'error' on itself, and an EventEmitter with no 'error' listener throws. Nothing above the
 * connection is on the stack at that point, so the throw was uncatchable and ended the
 * process. These tests pin the listener and the classification in place.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const clients: FakeClient[] = [];

/** Stands in for ImapFlow: an EventEmitter with the handful of methods in use. */
class FakeClient extends EventEmitter {
  closed = false;
  connect = connectMock;
  close = vi.fn(() => {
    this.closed = true;
  });
  logout = vi.fn(async () => undefined);
  getMailboxLock = vi.fn(async () => ({ release: vi.fn() }));
  mailbox = { exists: 0 };
  fetch = vi.fn(() => [] as unknown[]);
}

vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() {
      const client = new FakeClient();
      clients.push(client);
      return client as unknown as object;
    }
  },
}));

const { fetchMessages, ImapUnavailableError } = await import("../services/imap");

describe("imap connection handling", () => {
  it("listens for the error event, so a late fault cannot kill the process", async () => {
    connectMock.mockResolvedValueOnce(undefined);
    await fetchMessages("box@x.com", "token", "INBOX", 10);

    const client = clients.at(-1)!;
    expect(client.listenerCount("error")).toBeGreaterThan(0);

    // Unhandled, this throws out of the emit and there is no frame to catch it.
    expect(() => client.emit("error", new Error("socket reset"))).not.toThrow();
  });

  it("classifies Outlook's refusal as a mailbox problem, not a server fault", async () => {
    const refusal = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      responseText: "User is authenticated but not connected.",
    });
    connectMock.mockRejectedValueOnce(refusal);

    await expect(fetchMessages("box@x.com", "token", "INBOX", 10)).rejects.toBeInstanceOf(
      ImapUnavailableError,
    );
  });

  it("closes the client when connect fails, rather than leaving it to the library", async () => {
    connectMock.mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), { authenticationFailed: true }),
    );

    await fetchMessages("box@x.com", "token", "INBOX", 10).catch(() => undefined);
    expect(clients.at(-1)!.close).toHaveBeenCalled();
  });

  it("passes other connect failures through untouched", async () => {
    connectMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(fetchMessages("box@x.com", "token", "INBOX", 10)).rejects.toThrow("ECONNREFUSED");
  });
});
