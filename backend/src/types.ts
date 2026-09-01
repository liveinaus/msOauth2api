/** Shared shapes. Types rather than interfaces throughout, per project convention. */

/**
 * How an account's refresh token has to be spent.
 *
 * "auto" is the original behaviour: ask for a Graph token, and fall back to IMAP when the
 * registration was never granted Mail.Read. "imap" is for tokens consented only to the
 * older IMAP permission -- those must ask for the Outlook IMAP scope by name, and probing
 * Graph for them wastes a round trip that can only ever fail.
 */
export type AuthType = "auto" | "imap";

export const AUTH_TYPES: AuthType[] = ["auto", "imap"];

export function parseAuthType(value: unknown): AuthType | null {
  const normalised = typeof value === "string" ? value.trim().toLowerCase() : "";
  return AUTH_TYPES.includes(normalised as AuthType) ? (normalised as AuthType) : null;
}

/**
 * How far ahead of the rest of the pool an address is handed out.
 *
 * Bounded because the value is a rank, not a score: without a ceiling a few rounds of the
 * panel's bump buttons would leave numbers nothing else could ever catch up with.
 */
export const PRIORITY_MIN = -99;
export const PRIORITY_MAX = 99;

/** Reads a caller-supplied priority, or null when it is not a usable number. */
export function parsePriority(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return clampPriority(Math.trunc(n));
}

export function clampPriority(value: number): number {
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, value));
}

/**
 * Where an account connected through the OAuth callback lands in the queue.
 *
 * Relative to what is already in the pool, rather than a bare number, because that is how the
 * question is actually asked: a freshly connected mailbox is usually wanted either ahead of
 * everything or behind it, and what "ahead" means changes as the pool does. "normal" leaves
 * the row at the default rank, which is what happened before this was configurable.
 */
export const OAUTH_PRIORITY_MODES = [
  "normal",
  "highestPlusOne",
  "highest",
  "lowest",
  "lowestMinusOne",
  "fixed",
] as const;

export type OauthPriorityMode = (typeof OAUTH_PRIORITY_MODES)[number];

export function parseOauthPriorityMode(value: unknown): OauthPriorityMode | null {
  const normalised = typeof value === "string" ? value.trim() : "";
  return OAUTH_PRIORITY_MODES.includes(normalised as OauthPriorityMode)
    ? (normalised as OauthPriorityMode)
    : null;
}

/**
 * Columns the account list can be ordered by.
 *
 * An allow-list rather than a column name off the query string: the value reaches an ORDER
 * BY clause, which is one of the few places a prepared statement cannot parameterise.
 *
 * The verification code and the usage labels are not here. Both come from the usages table,
 * one row per type, so there is no single value per account to order by -- an address used
 * for three types would have three.
 */
export const ACCOUNT_SORT_KEYS = [
  "id",
  "priority",
  "email",
  "clientId",
  "status",
  "lastRefreshAt",
  "lastUsedAt",
] as const;

export type AccountSort = (typeof ACCOUNT_SORT_KEYS)[number];

export type SortDir = "asc" | "desc";

/** The order the panel has always shown: keenest first, then oldest row first. */
export const DEFAULT_ACCOUNT_SORT: AccountSort = "priority";
export const DEFAULT_SORT_DIR: SortDir = "desc";

export function parseAccountSort(value: unknown): AccountSort | null {
  const normalised = typeof value === "string" ? value.trim() : "";
  return ACCOUNT_SORT_KEYS.includes(normalised as AccountSort) ? (normalised as AccountSort) : null;
}

export function parseSortDir(value: unknown): SortDir | null {
  const normalised = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalised === "asc" || normalised === "desc" ? normalised : null;
}

/** A stored mail account. Secrets are decrypted by the time a caller sees this. */
export type Account = {
  id: number;
  email: string;
  password: string | null;
  clientId: string;
  refreshToken: string;
  authType: AuthType;
  priority: number;
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
  /**
   * Transport identifier: a Graph message id, or an IMAP UID as a string. Additive, like
   * `code`, and the handle a caller needs to delete one message rather than a whole folder.
   */
  id?: string;
};

/** Which transport served a request, for logging and the UI's account badges. */
export type MailTransport = "graph" | "imap";

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
};
