import { accountsNeedingRefresh } from "../db/accounts";
import {
  getAutoRefreshLastRun,
  getPanelSettings,
  setAutoRefreshLastRun,
} from "../db/panelSettings";
import { refreshAccounts } from "./tokenRefresh";

/**
 * The nightly sweep: refresh any token older than the configured number of days.
 *
 * Microsoft invalidates a refresh token that goes unused for long enough, and a panel whose
 * addresses are handed out unevenly will have some that nobody has touched in months. This
 * turns that from a surprise at the moment an address is needed into a scheduled job.
 *
 * Time of day rather than an interval because the run costs one token call per stale
 * account against an endpoint that throttles, so it belongs somewhere nothing else is
 * happening. It is driven by a one-minute tick and a stored date rather than a timer set to
 * fire in n hours: a container restarted at 03:59 would otherwise lose the run entirely, and
 * a long timer drifts across a daylight-saving change.
 */

/** How often the clock is checked. Cheap: two settings reads and a date comparison. */
const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
/** One run at a time, whatever the tick says: a slow sweep must not overlap the next. */
let running = false;

/** Local calendar date, which is what "already run today" is measured in. */
export function localDate(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function minutesInto(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

function scheduledMinutes(at: string): number {
  const [hours, minutes] = at.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Whether the sweep is due.
 *
 * A missed window is caught up rather than skipped -- a container down at 04:00 and back at
 * 06:00 still refreshes that day. What is deliberately not caught up is the very first tick
 * after the feature is switched on: with no run ever recorded, today's window is marked done
 * if it has already passed, so enabling this at midday does not immediately put the whole
 * panel through the token endpoint. The panel's own refresh button is there for that.
 */
export function isDue(lastRun: string, at: string, now: Date): boolean {
  const today = localDate(now);
  if (lastRun === today) return false;
  return minutesInto(now) >= scheduledMinutes(at);
}

export async function runSweep(now = new Date()): Promise<number> {
  const settings = getPanelSettings();
  if (settings.autoRefreshMaxDays <= 0) return 0;

  const stale = accountsNeedingRefresh(settings.autoRefreshMaxDays, now.getTime());
  if (stale.length === 0) {
    console.log(`[auto-refresh] nothing older than ${settings.autoRefreshMaxDays} day(s)`);
    return 0;
  }

  console.log(
    `[auto-refresh] refreshing ${stale.length} token(s) older than ${settings.autoRefreshMaxDays} day(s)`,
  );
  const results = await refreshAccounts(stale);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`[auto-refresh] done: ${results.length - failed} refreshed, ${failed} failed`);
  return results.length;
}

async function tick(): Promise<void> {
  if (running) return;
  const settings = getPanelSettings();
  if (settings.autoRefreshMaxDays <= 0) return;

  const now = new Date();
  const lastRun = getAutoRefreshLastRun();

  // First tick after it was switched on: adopt today rather than sweeping straight away.
  if (!lastRun) {
    setAutoRefreshLastRun(localDate(now));
    return;
  }
  if (!isDue(lastRun, settings.autoRefreshAt, now)) return;

  running = true;
  // Written before the run, not after: a sweep that throws half way through should not be
  // retried on the next tick, one minute later, against an endpoint that is already unhappy.
  setAutoRefreshLastRun(localDate(now));
  try {
    await runSweep(now);
  } catch (error) {
    console.error("[auto-refresh] sweep failed:", error);
  } finally {
    running = false;
  }
}

export function startAutoRefresh(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // Never the reason the process stays alive.
  timer.unref?.();
}

/** Test hook. */
export function stopAutoRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
