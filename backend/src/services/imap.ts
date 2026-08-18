import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Mailbox, MailMessage } from "../types";
import { extractCode } from "./codes";

const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;

/**
 * A mailbox that took the token but would not serve IMAP.
 *
 * Outlook answers `NO User is authenticated but not connected` when the OAuth grant is fine
 * but the mailbox is not reachable over IMAP: the protocol is switched off for it, the
 * account is blocked pending a sign-in, or it was never provisioned for IMAP at all. It is a
 * condition of the account rather than a fault here, and it does not clear on a retry, so it
 * gets its own type and callers can record it against the account.
 */
export class ImapUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("Mailbox is not available over IMAP");
    this.name = "ImapUnavailableError";
    this.detail = detail;
  }
}

function asConnectError(error: unknown): unknown {
  const failure = error as { authenticationFailed?: boolean; responseText?: string } | null;
  if (failure?.authenticationFailed) {
    return new ImapUnavailableError(failure.responseText ?? "authentication rejected");
  }
  return error;
}

/**
 * Opens an authenticated connection and always closes it again.
 *
 * imapflow replaces upstream's node-imap: the old library is callback-based, and its
 * response was assembled from event handlers that could resolve before the last message
 * finished parsing (mail-all raced its own `end` handler and could reply with a partial
 * list). Awaiting each message removes that class of bug entirely.
 */
async function withConnection<T>(
  email: string,
  accessToken: string,
  mailbox: Mailbox,
  readOnly: boolean,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, accessToken },
    // The library logs every command at info level, which on a mail endpoint means
    // dumping message metadata into the container log on every request.
    logger: false,
  });

  /**
   * Required, not optional hygiene: once connect() has settled, imapflow reports later
   * faults by emitting 'error' on itself. An EventEmitter with no 'error' listener throws,
   * and nothing above this is on the stack to catch it, so a mailbox dropping its socket
   * mid-session would take the whole process down with it.
   */
  client.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[imap] ${email}: connection error after connect: ${message}`);
  });

  try {
    await client.connect();
  } catch (error) {
    // The library schedules its own close on a failed connect; this makes it immediate and
    // does not depend on that staying true.
    client.close();
    throw asConnectError(error);
  }

  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly });
    try {
      return await work(client);
    } finally {
      lock.release();
    }
  } finally {
    // logout() is the graceful close; if the socket is already gone, force it down rather
    // than leaving a half-open connection behind.
    await client.logout().catch(() => client.close());
  }
}

async function parseMessage(source: Buffer, uid?: number): Promise<MailMessage> {
  const mail = await simpleParser(source);
  const text = mail.text ?? "";
  const html = typeof mail.html === "string" ? mail.html : "";

  const message: MailMessage = {
    send: mail.from?.text ?? "",
    subject: mail.subject ?? "",
    text,
    html,
    date: mail.date ? mail.date.toISOString() : "",
    // UID rather than sequence number: sequence numbers shift as the mailbox changes, so
    // one held by a browser would point at a different message by the time it is used.
    ...(uid === undefined ? {} : { id: String(uid) }),
  };

  const code = extractCode(text, html, message.subject);
  if (code) message.code = code;
  return message;
}

/**
 * Fetches up to `limit` messages, newest first.
 *
 * Sequence numbers are used rather than a full search: the newest mail is at the end of
 * the mailbox, so a range off the tail gets what is wanted without asking the server to
 * enumerate everything. Upstream searched ALL and sliced client-side, which on a mailbox
 * with thousands of messages fetched every one of them.
 */
export async function fetchMessages(
  email: string,
  accessToken: string,
  mailbox: Mailbox,
  limit: number,
): Promise<MailMessage[]> {
  return withConnection(email, accessToken, mailbox, true, async (client) => {
    const total = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
    if (!total) return [];

    const first = Math.max(1, total - limit + 1);
    const messages: MailMessage[] = [];

    for await (const item of client.fetch(`${first}:${total}`, { source: true, uid: true })) {
      if (item.source) messages.push(await parseMessage(item.source, item.uid));
    }

    // Ascending on the wire; the API contract is newest first.
    return messages.reverse();
  });
}

/**
 * Deletes one message by UID. Returns false when nothing matched, which is what a stale id
 * from an already-deleted message looks like.
 */
export async function deleteMessage(
  email: string,
  accessToken: string,
  mailbox: Mailbox,
  uid: string,
): Promise<boolean> {
  return withConnection(email, accessToken, mailbox, false, (client) =>
    client.messageDelete(uid, { uid: true }),
  );
}

/** Deletes everything in a folder. */
export async function purgeFolder(
  email: string,
  accessToken: string,
  mailbox: Mailbox,
): Promise<{ deleted: number }> {
  return withConnection(email, accessToken, mailbox, false, async (client) => {
    const total = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
    if (!total) return { deleted: 0 };

    await client.messageDelete(`1:${total}`);
    return { deleted: total };
  });
}
