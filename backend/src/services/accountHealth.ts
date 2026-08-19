/**
 * A fault has to repeat before it goes on the account.
 *
 * Recording one is not a note in a log: it puts the warning badge on the row and, because
 * the pool skips any account carrying an error, takes the address out of circulation until
 * somebody clears it by hand. That is far too much to spend on a single bad answer from
 * Microsoft, and every false alarm so far has been one -- a mailbox that was slow, or an
 * endpoint having a moment, marked as though its token were dead.
 *
 * So a verdict has to be reached twice in a row before it counts. A genuinely dead token
 * fails every time and is marked on the next attempt; a blip never gets a second one,
 * because the read that follows it succeeds and clears the count.
 *
 * Kept in memory on purpose: the streak only has to outlive a blip, and a restart erring
 * towards "give the account another chance" is the right way round.
 */
import { envMs } from "./http";

const failures = new Map<number, number>();

/** Consecutive failures needed before one is written against the account. */
const threshold = (): number => Math.max(1, Math.floor(envMs("ACCOUNT_FAULT_STREAK", 2)));

/** Counts a fault. True when it has now repeated often enough to be recorded. */
export function noteAccountFailure(id: number): boolean {
  const count = (failures.get(id) ?? 0) + 1;
  failures.set(id, count);
  return count >= threshold();
}

/** Anything that worked ends the streak. */
export function noteAccountSuccess(id: number): void {
  failures.delete(id);
}

/** Test seam; also keeps a deleted account from lingering in the map. */
export function forgetAccount(id: number): void {
  failures.delete(id);
}
