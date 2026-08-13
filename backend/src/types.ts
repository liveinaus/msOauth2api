/** Shared shapes. Types rather than interfaces throughout, per project convention. */

/** A stored mail account. Secrets are decrypted by the time a caller sees this. */
export type Account = {
  id: number;
  email: string;
  password: string | null;
  clientId: string;
  refreshToken: string;
  remark: string | null;
  disabled: boolean;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
  /** When the address was last copied out of the panel, i.e. handed to some other service. */
  lastCopiedAt: number | null;
  /** Arrival time of the newest message that landed after that copy. */
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** The two folders upstream allows. Anything else is rejected before it reaches a provider. */
export type Mailbox = "INBOX" | "Junk";

/**
 * One message, in the field names the upstream API returns. `send` (not `from`) and the
 * absence of an id are both upstream quirks kept for drop-in compatibility; `code` is the
 * one additive field, carrying an extracted verification code when the body has one.
 */
export type MailMessage = {
  send: string;
  subject: string;
  text: string;
  html: string;
  date: string;
  code?: string;
};

/** Which transport served a request, for logging and the UI's account badges. */
export type MailTransport = "graph" | "imap";

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
};
