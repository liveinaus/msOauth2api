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
