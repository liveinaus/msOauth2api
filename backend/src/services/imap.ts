import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Mailbox, MailMessage } from "../types";
import { extractCode } from "./codes";
import { envMs } from "./http";

const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;

/**
 * How long a mailbox is given, and how many goes it gets.
 *
 * Outlook is regularly slow rather than broken -- a mailbox that takes twenty seconds to
 * answer is still a working mailbox -- and imapflow ships a 90 second connect budget with no
 * ceiling on the operation as a whole. Both ends of that were wrong here: a code fetch that
 * hangs for a minute and a half is no use to a poller, and one that gives up at the first
 * stumble sends the caller off to read the code by hand. So the whole operation, retries
 * included, runs under one budget, and a stumble inside it is retried.
 *
 * Read per call rather than at import so a deployment can tune them without a rebuild.
 */
const timeouts = () => ({
  /** The whole operation, retries and backoff included. */
  total: envMs("IMAP_TIMEOUT_MS", 45_000),
  connect: envMs("IMAP_CONNECT_TIMEOUT_MS", 20_000),
  greeting: envMs("IMAP_GREETING_TIMEOUT_MS", 20_000),
  /** Socket inactivity, which is what covers a stalled fetch of a large message. */
  socket: envMs("IMAP_SOCKET_TIMEOUT_MS", 30_000),
  attempts: Math.max(1, Math.floor(envMs("IMAP_ATTEMPTS", 3))),
  retryDelay: envMs("IMAP_RETRY_DELAY_MS", 1_000),
});

/** Below this there is no time left to do anything useful, so the retry loop stops. */
const MIN_ATTEMPT_MS = 4_000;

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

/**
 * A mailbox that was reachable but did not answer in time.
 *
 * Distinct from ImapUnavailableError in the one way that matters to a caller: it says
 * nothing about the account, so the address stays in the pool and the next poll is worth
 * making. Outlook being slow is the normal case behind it.
 */
export class ImapTemporaryError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("Mailbox could not be read right now, try again");
    this.name = "ImapTemporaryError";
    this.detail = detail;
  }
}

/** The shape imapflow errors arrive in, across its connect, auth and command paths. */
type ImapFailure = {
  authenticationFailed?: boolean;
  responseText?: string;
  responseStatus?: string;
  response?: unknown;
  serverResponseCode?: string;
  code?: string;
  message?: string;
};

/** Network and protocol faults that say nothing about the mailbox, only about the moment. */
const TRANSIENT_CODES = new Set([
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ESOCKET",
  "ETHROTTLE",
  "NoConnection",
]);

/**
 * Server text that means this mailbox will not serve IMAP however many times it is asked.
 *
 * Everything outside this list is treated as passing weather. That way round because
 * imapflow flags *every* fault raised during AUTHENTICATE as an authentication failure --
 * a dropped socket and an expired connect deadline included -- so trusting that flag alone
 * turned a slow mailbox into a permanently condemned one.
 */
const PERMANENT_REFUSALS = [
  /authenticated but not connected/i,
  /imap[^.]{0,30}(disabled|not enabled)/i,
  /(disabled|not enabled)[^.]{0,30}imap/i,
  /basic authentication is disabled/i,
];

/** Best readable text imapflow left on the error, whichever path raised it. */
function failureDetail(failure: ImapFailure): string {
  const response = typeof failure.response === "string" ? failure.response : "";
  return (
    failure.responseText ||
    response ||
    failure.serverResponseCode ||
    failure.message ||
    "no detail from server"
  ).trim();
}

function isPermanentRefusal(failure: ImapFailure, detail: string): boolean {
  if (failure.serverResponseCode === "AUTHENTICATIONFAILED") return true;
  return PERMANENT_REFUSALS.some((pattern) => pattern.test(detail));
}

/**
 * Sorts a connect failure into "this mailbox is finished" and "try again".
 *
 * Only the first kind becomes an ImapUnavailableError, because only that kind should be
 * recorded against the account and take the address out of the pool.
 */
function classifyConnectError(error: unknown): unknown {
  const failure = error as ImapFailure | null;
  if (!failure?.authenticationFailed) return error;

  const detail = failureDetail(failure);
  return isPermanentRefusal(failure, detail) ? new ImapUnavailableError(detail) : error;
}

/**
 * Whether the fault is the connection rather than the request.
 *
 * A timeout, a dropped socket, a throttle, or a server-side NO/BAD are all worth another
 * go. Anything else -- a bug in the work callback, say -- is passed through untouched
 * rather than retried and relabelled, so a real fault still looks like one.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof ImapUnavailableError) return false;
  if (error instanceof ImapTemporaryError) return true;

  const failure = error as ImapFailure | null;
  if (!failure) return false;
  if (failure.authenticationFailed) return true;
  if (failure.code && TRANSIENT_CODES.has(failure.code)) return true;
  return failure.responseStatus === "NO" || failure.responseStatus === "BAD";
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens an authenticated connection, runs `work`, and always closes it again.
 *
 * imapflow replaces upstream's node-imap: the old library is callback-based, and its
 * response was assembled from event handlers that could resolve before the last message
 * finished parsing (mail-all raced its own `end` handler and could reply with a partial
 * list). Awaiting each message removes that class of bug entirely.
 *
 * The attempt runs under a hard deadline enforced by closing the socket: imapflow's own
 * timeouts cover the connect and idle sockets, but nothing caps the session as a whole, and
 * a caller polling for a code needs an answer more than it needs this one connection.
 */
async function attemptConnection<T>(
  email: string,
  accessToken: string,
  mailbox: Mailbox,
  readOnly: boolean,
  work: (client: ImapFlow) => Promise<T>,
  budgetMs: number,
): Promise<T> {
  const limits = timeouts();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, accessToken },
    // The library logs every command at info level, which on a mail endpoint means
    // dumping message metadata into the container log on every request.
    logger: false,
    connectionTimeout: Math.min(limits.connect, budgetMs),
    greetingTimeout: Math.min(limits.greeting, budgetMs),
    socketTimeout: Math.min(limits.socket, budgetMs),
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

  // Closing the socket is what actually stops the work: whatever is in flight rejects, and
  // the flag turns that rejection into the timeout it really was.
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    client.close();
  }, budgetMs);

  const asTimeout = (error: unknown): unknown =>
    expired ? new ImapTemporaryError(`no response within ${Math.round(budgetMs / 1000)}s`) : error;

  try {
    try {
      await client.connect();
    } catch (error) {
      // The library schedules its own close on a failed connect; this makes it immediate and
      // does not depend on that staying true.
      client.close();
      throw asTimeout(classifyConnectError(error));
    }

    try {
      const lock = await client.getMailboxLock(mailbox, { readOnly });
      try {
        return await work(client);
      } finally {
        lock.release();
      }
    } catch (error) {
      throw asTimeout(error);
    } finally {
      // logout() is the graceful close; if the socket is already gone, force it down rather
      // than leaving a half-open connection behind.
      await client.logout().catch(() => client.close());
    }
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Runs an operation against the mailbox, retrying inside the budget.
 *
 * `work` is re-run from a fresh connection on a retry, so it has to be repeatable; every
 * caller below either reads, or deletes by identity, so re-running one is harmless.
 */
async function withConnection<T>(
  email: string,
  accessToken: string,
  mailbox: Mailbox,
  readOnly: boolean,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const limits = timeouts();
  const finishBy = Date.now() + limits.total;
  let lastError: unknown;

  for (let attempt = 1; attempt <= limits.attempts; attempt++) {
    const remaining = finishBy - Date.now();
    if (attempt > 1 && remaining < MIN_ATTEMPT_MS) break;

    try {
      return await attemptConnection(
        email,
        accessToken,
        mailbox,
        readOnly,
        work,
        Math.max(remaining, MIN_ATTEMPT_MS),
      );
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === limits.attempts) break;

      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[imap] ${email}: attempt ${attempt} failed (${detail}), retrying`);
      await delay(limits.retryDelay * attempt);
    }
  }

  // A transient fault that outlasted the budget is still not the account's fault, so it is
  // reported as temporary: the caller should poll again rather than write the address off.
  if (isTransient(lastError) && !(lastError instanceof ImapTemporaryError)) {
    throw new ImapTemporaryError(failureDetail((lastError ?? {}) as ImapFailure));
  }
  throw lastError;
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
