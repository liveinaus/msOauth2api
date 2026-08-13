/**
 * The panel's cache of each account's newest message, and the short poll that runs after an
 * address is copied.
 *
 * Module state rather than component state so a poll keeps running while you are off in a
 * mailbox or on the settings page -- the whole point is to catch a code that arrives a
 * minute after you paste the address into somebody's signup form.
 *
 * Nothing is persisted: message bodies stay in memory for the life of the tab, the same way
 * the mailbox view holds them, so a shared machine keeps no trace after a reload.
 */
import { ref } from "vue";
import { fetchLatestMail, type AccountView, type MailMessage } from "../api/client";

export type LatestEntry = {
  message: MailMessage | null;
  fetchedAt: number;
  error: string;
};

type PollState = {
  /** Wall-clock deadline for the poll. */
  until: number;
  /** Copy time, in server clock terms: mail at or after this is what the poll is waiting for. */
  since: number;
  /** Set when the copy was scoped to an integration type, so its rules do the matching. */
  type?: string;
  failures: number;
};

const entries = ref<Record<number, LatestEntry>>({});
const polls = ref<Record<number, PollState>>({});
const timers = new Map<number, number>();

/** Ticks once a second while anything is polling, so a countdown needs no timer of its own. */
export const clock = ref(Date.now());
let tickTimer: number | null = null;

const accountListeners = new Set<(account: AccountView) => void>();

/** Lets the accounts table update a row when a poll brings back a newer account record. */
export function onAccountUpdate(listener: (account: AccountView) => void): () => void {
  accountListeners.add(listener);
  return () => accountListeners.delete(listener);
}

export function latestFor(id: number): LatestEntry | undefined {
  return entries.value[id];
}

export function pollDeadline(id: number): number | null {
  return polls.value[id]?.until ?? null;
}

export function isPolling(id: number): boolean {
  return id in polls.value;
}

export async function refreshLatest(id: number, type?: string): Promise<AccountView | null> {
  try {
    const result = await fetchLatestMail(id, type);
    entries.value = {
      ...entries.value,
      [id]: { message: result.message, fetchedAt: Date.now(), error: "" },
    };
    accountListeners.forEach((listener) => listener(result.account));
    return result.account;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entries.value = {
      ...entries.value,
      [id]: { message: entries.value[id]?.message ?? null, fetchedAt: Date.now(), error: message },
    };
    return null;
  }
}

export function startPolling(
  id: number,
  options: { durationMs: number; intervalMs: number; since: number; type?: string },
): void {
  stopPolling(id);
  polls.value = {
    ...polls.value,
    [id]: {
      until: Date.now() + options.durationMs,
      since: options.since,
      type: options.type,
      failures: 0,
    },
  };
  startTick();
  void pollOnce(id, options.intervalMs);
}

export function stopPolling(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);

  if (id in polls.value) {
    const next = { ...polls.value };
    delete next[id];
    polls.value = next;
  }
  if (!Object.keys(polls.value).length) stopTick();
}

async function pollOnce(id: number, intervalMs: number): Promise<void> {
  const pending = polls.value[id];
  if (!pending) return;

  const account = await refreshLatest(id, pending.type);
  const state = polls.value[id];
  // A stop while the request was in flight.
  if (!state) return;

  if (account) {
    state.failures = 0;
  } else if (++state.failures >= 3) {
    // Three failures running is a dead token or an unreachable mailbox, not a blip, and
    // there is no point spending the rest of the window on it.
    stopPolling(id);
    return;
  }

  const message = entries.value[id]?.message;
  const arrived = message ? Date.parse(message.date) >= state.since : false;
  if ((message?.code && arrived) || Date.now() >= state.until) {
    stopPolling(id);
    return;
  }

  timers.set(
    id,
    window.setTimeout(() => void pollOnce(id, intervalMs), intervalMs),
  );
}

function startTick(): void {
  if (tickTimer !== null) return;
  clock.value = Date.now();
  tickTimer = window.setInterval(() => (clock.value = Date.now()), 1000);
}

function stopTick(): void {
  if (tickTimer === null) return;
  window.clearInterval(tickTimer);
  tickTimer = null;
}
