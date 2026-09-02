/**
 * The scheduled account check: is each mailbox still one Microsoft will serve?
 *
 * A mailbox connected through the OAuth callback can be put into service abuse mode within
 * hours, and nothing tells the panel. The row keeps looking healthy until an address is
 * handed out and the read fails, which is the worst moment to find out. This spends one
 * token call per due account instead, and anything Microsoft has blocked is disabled with a
 * reason and a note against it -- see the abuse branch in tokenRefresh.
 *
 * Which accounts are due comes from the rules in Settings, each a priority band with its own
 * interval, so the ends of the pool can be checked at different rates: the addresses nobody
 * has spent yet rarely need it, while the ones parked at the bottom usually do.
 *
 * Scheduled the same way as the refresh sweep -- a one-minute tick against a stored date,
 * not a long timer -- so a restart cannot lose the window and a daylight-saving change
 * cannot drift it.
 */
import { accountsNeedingVerify } from "../db/accounts";
import { getPanelSettings, getVerifyLastRun, setVerifyLastRun } from "../db/panelSettings";
import type { Account, VerifyRule } from "../types";
import { isDue, localDate } from "./autoRefresh";
import { refreshAccounts } from "./tokenRefresh";

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
/** One run at a time, whatever the tick says. */
let running = false;

export type VerifyReport = {
  checked: number;
  failed: number;
  /** How many the run took out of the pool, service abuse mode being the usual cause. */
  blocked: number;
};

/**
 * The accounts due across every rule, each appearing once.
 *
 * Bands are allowed to overlap -- they are two answers to "how often should this end of the
 * pool be checked", not a partition -- so an account matching several rules is due under the
 * shortest of them and must still only cost one call.
 */
export function dueAccounts(rules: VerifyRule[], now = Date.now()): Account[] {
  const byId = new Map<number, Account>();
  for (const rule of rules) {
    for (const account of accountsNeedingVerify(rule, now)) {
      if (!byId.has(account.id)) byId.set(account.id, account);
    }
  }
  return [...byId.values()];
}

export async function runVerify(now = new Date()): Promise<VerifyReport> {
  const empty: VerifyReport = { checked: 0, failed: 0, blocked: 0 };
  const { verifyRules } = getPanelSettings();
  if (verifyRules.length === 0) return empty;

  const targets = dueAccounts(verifyRules, now.getTime());
  if (targets.length === 0) {
    console.log(`[verify] nothing due across ${verifyRules.length} rule(s)`);
    return empty;
  }

  console.log(`[verify] checking ${targets.length} account(s)`);
  const results = await refreshAccounts(targets);
  const report: VerifyReport = {
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    blocked: results.filter((r) => r.blocked).length,
  };
  console.log(
    `[verify] done: ${report.checked - report.failed} answered, ${report.failed} failed, ` +
      `${report.blocked} disabled`,
  );
  return report;
}

async function tick(): Promise<void> {
  if (running) return;
  const settings = getPanelSettings();
  if (settings.verifyRules.length === 0) return;

  const now = new Date();
  const lastRun = getVerifyLastRun();

  // First tick after the rules were added: adopt today rather than checking straight away,
  // so saving a rule at midday does not put the whole pool through the token endpoint.
  if (!lastRun) {
    setVerifyLastRun(localDate(now));
    return;
  }
  if (!isDue(lastRun, settings.verifyAt, now)) return;

  running = true;
  // Written before the run: a check that throws half way through should not be retried a
  // minute later against an endpoint that is already unhappy.
  setVerifyLastRun(localDate(now));
  try {
    await runVerify(now);
  } catch (error) {
    console.error("[verify] run failed:", error);
  } finally {
    running = false;
  }
}

export function startAccountVerify(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // Never the reason the process stays alive.
  timer.unref?.();
}

/** Test hook. */
export function stopAccountVerify(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
