import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Mailbox, MailMessage } from "../types";
import { extractCode } from "./codes";

const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;

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

  await client.connect();
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

async function parseMessage(source: Buffer): Promise<MailMessage> {
  const mail = await simpleParser(source);
  const text = mail.text ?? "";
  const html = typeof mail.html === "string" ? mail.html : "";

  const message: MailMessage = {
    send: mail.from?.text ?? "",
    subject: mail.subject ?? "",
    text,
    html,
    date: mail.date ? mail.date.toISOString() : "",
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

    for await (const item of client.fetch(`${first}:${total}`, { source: true })) {
      if (item.source) messages.push(await parseMessage(item.source));
    }

    // Ascending on the wire; the API contract is newest first.
    return messages.reverse();
  });
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
