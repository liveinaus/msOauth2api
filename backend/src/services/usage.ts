import { getAccountByEmail, recordUsage } from "../db/accounts";
import { getPanelSettings } from "../db/panelSettings";
import type { MailMessage } from "../types";

/**
 * Marks a stored address as used when mail arrives after it was copied.
 *
 * "Used" is deliberately narrower than "has mail": an address that was never copied out of
 * the panel cannot have been given to anything, and mail predating the copy belongs to
 * whatever it was used for last time. So only a message newer than the copy counts, and the
 * stamp is the message's own arrival time rather than the time it happened to be read --
 * that keeps the column stable no matter when the mailbox is next opened.
 *
 * Called on every read path, so the date fills in from a routine mailbox visit and does not
 * need the quick-look button. Does nothing when the panel is set to mark on copy alone.
 */
export function noteUsage(email: string, messages: MailMessage[]): void {
  // In "copy" mode the copy itself is the whole rule, so arriving mail must not move the
  // date -- it is answering a different question there.
  if (getPanelSettings().usageMode === "copy") return;

  const account = getAccountByEmail(email);
  if (!account) return;

  const usedAt = usedAtFrom(messages, account.lastCopiedAt, account.lastUsedAt);
  if (usedAt !== null) recordUsage(account.id, usedAt);
}

/**
 * The rule itself, kept free of the database so it can be tested directly. Returns the
 * timestamp to store, or null when nothing qualifies.
 */
export function usedAtFrom(
  messages: MailMessage[],
  lastCopiedAt: number | null,
  lastUsedAt: number | null,
): number | null {
  if (!lastCopiedAt) return null;

  let newest = 0;
  for (const message of messages) {
    const at = Date.parse(message.date);
    if (Number.isFinite(at) && at > newest) newest = at;
  }

  if (newest <= lastCopiedAt) return null;
  if (lastUsedAt !== null && newest <= lastUsedAt) return null;
  return newest;
}
