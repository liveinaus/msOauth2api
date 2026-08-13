import type { Mailbox, MailMessage, MailTransport } from "../types";
import * as graph from "./graph";
import * as imap from "./imap";
import { getMailAccessToken, probeGraphAccess } from "./oauth";

export type MailCredentials = {
  email: string;
  clientId: string;
  refreshToken: string;
};

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
 * request compared with going straight to IMAP.
 */
export async function readMail(
  credentials: MailCredentials,
  mailbox: Mailbox,
  limit: number,
): Promise<MailResult> {
  const probe = await probeGraphAccess(credentials.refreshToken, credentials.clientId);

  if (probe.available) {
    return {
      messages: await graph.listMessages(probe.accessToken, mailbox, limit),
      transport: "graph",
      rotatedRefreshToken: probe.refreshToken,
    };
  }

  const token = await getMailAccessToken(credentials.refreshToken, credentials.clientId);
  return {
    messages: await imap.fetchMessages(credentials.email, token.accessToken, mailbox, limit),
    transport: "imap",
    rotatedRefreshToken: token.refreshToken,
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
 */
export async function readFolders(
  credentials: MailCredentials,
  mailboxes: Mailbox[],
  limit: number,
): Promise<FoldersResult> {
  const probe = await probeGraphAccess(credentials.refreshToken, credentials.clientId);
  const messages: FolderMessage[] = [];

  if (probe.available) {
    for (const mailbox of mailboxes) {
      const found = await graph.listMessages(probe.accessToken, mailbox, limit);
      messages.push(...found.map((message) => ({ ...message, mailbox })));
    }
    return {
      messages: sortByDate(messages),
      transport: "graph",
      rotatedRefreshToken: probe.refreshToken,
    };
  }

  const token = await getMailAccessToken(credentials.refreshToken, credentials.clientId);
  for (const mailbox of mailboxes) {
    const found = await imap.fetchMessages(credentials.email, token.accessToken, mailbox, limit);
    messages.push(...found.map((message) => ({ ...message, mailbox })));
  }
  return {
    messages: sortByDate(messages),
    transport: "imap",
    rotatedRefreshToken: token.refreshToken,
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
  const probe = await probeGraphAccess(credentials.refreshToken, credentials.clientId);

  if (probe.available) {
    const { deleted } = await graph.purgeFolder(probe.accessToken, mailbox);
    return { deleted, transport: "graph", rotatedRefreshToken: probe.refreshToken };
  }

  const token = await getMailAccessToken(credentials.refreshToken, credentials.clientId);
  const { deleted } = await imap.purgeFolder(credentials.email, token.accessToken, mailbox);
  return { deleted, transport: "imap", rotatedRefreshToken: token.refreshToken };
}
