import type { AuthType, Mailbox, MailMessage, MailTransport } from "../types";
import * as graph from "./graph";
import * as imap from "./imap";
import {
  getImapAccessToken,
  getMailAccessToken,
  isGraphConsentFailure,
  probeGraphAccess,
} from "./oauth";

export type MailCredentials = {
  email: string;
  clientId: string;
  refreshToken: string;
  /** Absent means "auto", so a caller that predates the field behaves as it always did. */
  authType?: AuthType;
};

type OpenTransport = {
  kind: MailTransport;
  accessToken: string;
  rotatedRefreshToken: string | null;
};

/**
 * Gets a token and settles which transport it is good for.
 *
 * Every operation below needs exactly this and then differs only in what it does with the
 * connection, so the choice lives here rather than being repeated four times.
 *
 * An "imap" account skips the Graph probe outright: its consent never covered Graph, so the
 * probe could only ever come back unavailable, having spent a round trip to say so.
 *
 * On the "auto" path the probe can fail two ways for a Graph-less account: it may answer
 * without Mail.Read (available: false), or, when there is no Graph consent at all, it may be
 * rejected outright and throw. Both mean the same thing here -- use IMAP -- so a consent
 * failure degrades to the IMAP path rather than surfacing as an error. A genuinely dead
 * token still throws, from whichever grant it is spent on.
 */
async function openTransport(credentials: MailCredentials): Promise<OpenTransport> {
  if (credentials.authType === "imap") {
    const token = await getImapAccessToken(credentials.refreshToken, credentials.clientId);
    return {
      kind: "imap",
      accessToken: token.accessToken,
      rotatedRefreshToken: token.refreshToken,
    };
  }

  try {
    const probe = await probeGraphAccess(credentials.refreshToken, credentials.clientId);
    if (probe.available) {
      return {
        kind: "graph",
        accessToken: probe.accessToken,
        rotatedRefreshToken: probe.refreshToken,
      };
    }
  } catch (error) {
    if (!isGraphConsentFailure(error)) throw error;
  }

  const token = await getMailAccessToken(credentials.refreshToken, credentials.clientId);
  return { kind: "imap", accessToken: token.accessToken, rotatedRefreshToken: token.refreshToken };
}

export type MailResult = {
  messages: MailMessage[];
  transport: MailTransport;
  /** Set when Microsoft rolled the refresh token, so the caller can persist the new one. */
  rotatedRefreshToken: string | null;
};

/**
 * Graph first, IMAP as the fallback, matching upstream's preference: Graph is faster, is
 * not rate-limited the way IMAP is, and does not need a second round trip per message.
 *
 * The probe doubles as the Graph token fetch, so choosing a transport costs no extra
 * request compared with going straight to IMAP. An "imap" account bypasses the choice.
 */
export async function readMail(
  credentials: MailCredentials,
  mailbox: Mailbox,
  limit: number,
): Promise<MailResult> {
  const transport = await openTransport(credentials);

  const messages =
    transport.kind === "graph"
      ? await graph.listMessages(transport.accessToken, mailbox, limit)
      : await imap.fetchMessages(credentials.email, transport.accessToken, mailbox, limit);

  return {
    messages,
    transport: transport.kind,
    rotatedRefreshToken: transport.rotatedRefreshToken,
  };
}

export type FolderMessage = MailMessage & { mailbox: Mailbox };

export type FoldersResult = {
  messages: FolderMessage[];
  transport: MailTransport;
  rotatedRefreshToken: string | null;
};

/**
 * Reads several folders in one go, newest first across all of them.
 *
 * One probe and one token cover every folder: calling readMail per folder would repeat the
 * OAuth round trip each time, which on a poll running every twenty seconds is the bulk of
 * the work. Folders are read one after another rather than at once because the IMAP path
 * opens a connection per call, and Microsoft throttles an account that fans out.
 *
 * A folder that fails does not sink the call as long as another one answered. The point of
 * reading both is to find one code, and losing the inbox's copy of it because the junk
 * folder timed out is the worst of both: the code was there and the caller was told nothing
 * was. Only every folder failing is an error.
 */
export async function readFolders(
  credentials: MailCredentials,
  mailboxes: Mailbox[],
  limit: number,
): Promise<FoldersResult> {
  const transport = await openTransport(credentials);
  const messages: FolderMessage[] = [];
  let read = 0;
  let failure: unknown;

  for (const mailbox of mailboxes) {
    try {
      const found =
        transport.kind === "graph"
          ? await graph.listMessages(transport.accessToken, mailbox, limit)
          : await imap.fetchMessages(credentials.email, transport.accessToken, mailbox, limit);
      messages.push(...found.map((message) => ({ ...message, mailbox })));
      read++;
    } catch (error) {
      failure ??= error;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[mail] ${credentials.email}: could not read ${mailbox}: ${detail}`);
    }
  }

  if (!read && failure) throw failure;

  return {
    messages: sortByDate(messages),
    transport: transport.kind,
    rotatedRefreshToken: transport.rotatedRefreshToken,
  };
}

/** Newest first. An unparseable date counts as the epoch, so it sorts last. */
export function sortByDate<T extends { date: string }>(messages: T[]): T[] {
  const at = (message: T): number => {
    const parsed = Date.parse(message.date);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return [...messages].sort((a, b) => at(b) - at(a));
}

/**
 * The message the panel should show for an account.
 *
 * The newest one carrying a code beats a newer one without: the code column is the point of
 * the call, and a newsletter landing on top of the verification mail would otherwise bury
 * it. With no code anywhere, the newest message stands in.
 */
export function pickForPanel<T extends { code?: string }>(messages: T[]): T | null {
  return messages.find((message) => message.code) ?? messages[0] ?? null;
}

export type DeleteResult = {
  deleted: boolean;
  transport: MailTransport;
  rotatedRefreshToken: string | null;
};

/**
 * Deletes one message, over whichever transport this account uses.
 *
 * The id has to have come from a read over the same transport: Graph ids and IMAP UIDs are
 * not interchangeable. That holds in practice because the transport is decided by the
 * account's granted scopes, not per request.
 */
export async function deleteMessage(
  credentials: MailCredentials,
  mailbox: Mailbox,
  id: string,
): Promise<DeleteResult> {
  const transport = await openTransport(credentials);

  if (transport.kind === "graph") {
    await graph.deleteMessage(transport.accessToken, id);
    return {
      deleted: true,
      transport: "graph",
      rotatedRefreshToken: transport.rotatedRefreshToken,
    };
  }

  const deleted = await imap.deleteMessage(credentials.email, transport.accessToken, mailbox, id);
  return { deleted, transport: "imap", rotatedRefreshToken: transport.rotatedRefreshToken };
}

export type PurgeResult = {
  deleted: number;
  transport: MailTransport;
  rotatedRefreshToken: string | null;
};

/** Empties a folder, over whichever transport the account supports. */
export async function purgeMail(
  credentials: MailCredentials,
  mailbox: Mailbox,
): Promise<PurgeResult> {
  const transport = await openTransport(credentials);

  const { deleted } =
    transport.kind === "graph"
      ? await graph.purgeFolder(transport.accessToken, mailbox)
      : await imap.purgeFolder(credentials.email, transport.accessToken, mailbox);

  return { deleted, transport: transport.kind, rotatedRefreshToken: transport.rotatedRefreshToken };
}
