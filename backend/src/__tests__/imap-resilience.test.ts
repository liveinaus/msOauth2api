/**
 * Two failures are pinned here.
 *
 * The first took the process down: imapflow reports post-connect faults by emitting 'error'
 * on itself, and an EventEmitter with no 'error' listener throws. Nothing above the
 * connection is on the stack at that point, so the throw was uncatchable.
 *
 * The second condemned working mailboxes: imapflow flags every fault raised during
 * AUTHENTICATE as an authentication failure, a dropped socket and an expired deadline
 * included, and that flag alone was taken as "this mailbox will not serve IMAP" -- which is
 * recorded against the account and takes the address out of the pool. A slow Outlook is not
 * a broken one, so only the refusals Outlook actually spells out count as permanent, and
 * everything else is retried inside the budget.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.IMAP_RETRY_DELAY_MS = "1";

const connectMock = vi.fn();
const lockMock = vi.fn(async () => ({ release: vi.fn() }));
const clients: FakeClient[] = [];
const options: Record<string, unknown>[] = [];

/** Stands in for ImapFlow: an EventEmitter with the handful of methods in use. */
class FakeClient extends EventEmitter {
  closed = false;
  connect = connectMock;
  close = vi.fn(() => {
    this.closed = true;
  });
  logout = vi.fn(async () => undefined);
  getMailboxLock = lockMock;
  mailbox = { exists: 0 };
  fetch = vi.fn(() => [] as unknown[]);
}

vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: Record<string, unknown>) {
      options.push(opts);
      const client = new FakeClient();
      clients.push(client);
      return client as unknown as object;
    }
  },
}));

const { fetchMessages, ImapTemporaryError, ImapUnavailableError } =
  await import("../services/imap");

/** Outlook's own wording for a mailbox that is not reachable over IMAP at all. */
const refusal = () =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    response: "* BAD User is authenticated but not connected.",
  });

/** What a slow or dropped handshake looks like: flagged as auth, with nothing behind it. */
const stumble = () =>
  Object.assign(new Error("Failed to establish connection in required time"), {
    authenticationFailed: true,
    code: "CONNECT_TIMEOUT",
  });

beforeEach(() => {
  connectMock.mockReset();
  lockMock.mockReset();
  lockMock.mockResolvedValue({ release: vi.fn() });
  clients.length = 0;
  options.length = 0;
});

describe("imap connection handling", () => {
  it("listens for the error event, so a late fault cannot kill the process", async () => {
    connectMock.mockResolvedValue(undefined);
    await fetchMessages("box@x.com", "token", "INBOX", 10);

    const client = clients.at(-1)!;
    expect(client.listenerCount("error")).toBeGreaterThan(0);

    // Unhandled, this throws out of the emit and there is no frame to catch it.
    expect(() => client.emit("error", new Error("socket reset"))).not.toThrow();
  });

  it("gives the connection explicit timeouts rather than the library's defaults", async () => {
    connectMock.mockResolvedValue(undefined);
    await fetchMessages("box@x.com", "token", "INBOX", 10);

    expect(options.at(-1)).toMatchObject({
      connectionTimeout: expect.any(Number),
      greetingTimeout: expect.any(Number),
      socketTimeout: expect.any(Number),
    });
  });

  it("classifies Outlook's refusal as a mailbox problem, and does not retry it", async () => {
    connectMock.mockRejectedValue(refusal());

    await expect(fetchMessages("box@x.com", "token", "INBOX", 10)).rejects.toBeInstanceOf(
      ImapUnavailableError,
    );
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("retries a handshake that merely stumbled, rather than condemning the mailbox", async () => {
    connectMock.mockRejectedValueOnce(stumble()).mockResolvedValue(undefined);

    await expect(fetchMessages("box@x.com", "token", "INBOX", 10)).resolves.toEqual([]);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("reports a stumble that outlasts every attempt as temporary, not as unavailable", async () => {
    connectMock.mockRejectedValue(stumble());

    const error = await fetchMessages("box@x.com", "token", "INBOX", 10).catch((e) => e);
    expect(error).toBeInstanceOf(ImapTemporaryError);
    expect(error).not.toBeInstanceOf(ImapUnavailableError);
    expect(connectMock).toHaveBeenCalledTimes(3);
  });

  it("closes the client when connect fails, rather than leaving it to the library", async () => {
    connectMock.mockRejectedValue(refusal());

    await fetchMessages("box@x.com", "token", "INBOX", 10).catch(() => undefined);
    expect(clients.at(-1)!.close).toHaveBeenCalled();
  });

  it("retries a dropped socket", async () => {
    connectMock
      .mockRejectedValueOnce(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }))
      .mockResolvedValue(undefined);

    await expect(fetchMessages("box@x.com", "token", "INBOX", 10)).resolves.toEqual([]);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("passes a fault that is not the connection through untouched", async () => {
    connectMock.mockResolvedValue(undefined);
    lockMock.mockRejectedValueOnce(new Error("mailparser blew up"));

    await expect(fetchMessages("box@x.com", "token", "INBOX", 10)).rejects.toThrow(
      "mailparser blew up",
    );
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
