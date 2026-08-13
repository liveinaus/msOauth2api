/** Message filtering for the integration API's get-code endpoint. */
import type { MailMessage } from "../types";

export type CodeQuery = {
  /** Ignore anything older than this, in epoch milliseconds. */
  since?: number;
  /** Case-insensitive substring of the sender address. */
  from?: string;
  /** Case-insensitive substring of the subject line. */
  subject?: string;
};

/** Accepts epoch milliseconds or anything Date can parse, so callers can send either. */
export function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * A message with an unparseable date fails a `since` test rather than passing it: the whole
 * point of the window is to keep a previous run's code out of this run's answer, and a
 * message that cannot prove it is recent should not be trusted to be.
 */
export function matchesQuery(message: MailMessage, query: CodeQuery): boolean {
  if (query.since !== undefined) {
    const at = Date.parse(message.date);
    if (Number.isNaN(at) || at < query.since) return false;
  }
  if (query.from && !contains(message.send ?? "", query.from)) return false;
  if (query.subject && !contains(message.subject ?? "", query.subject)) return false;
  return true;
}

/**
 * The newest matching message that carries a code. Messages are expected newest first, as
 * the folder readers return them.
 */
export function findCode<T extends MailMessage>(messages: T[], query: CodeQuery): T | undefined {
  return messages.find((message) => message.code && matchesQuery(message, query));
}
