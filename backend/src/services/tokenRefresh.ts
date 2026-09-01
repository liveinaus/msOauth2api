import { recordRefresh } from "../db/accounts";
import type { Account } from "../types";
import { noteAccountFailure, noteAccountSuccess } from "./accountHealth";
import { exchangeRefreshToken, isGrantFailure, OAuthError, refreshScopeFor } from "./oauth";

export type RefreshResult = { id: number; email: string; ok: boolean; error?: string };

/**
 * Microsoft throttles the token endpoint, so a panel's worth of accounts goes a few at a
 * time. Upstream's browser loop fired one unbounded request per account and mostly got
 * rate-limited answers back.
 */
const CONCURRENCY = 3;

/**
 * Refreshes a set of accounts, reporting per account rather than aborting the run.
 *
 * Shared by the panel's button and the nightly sweep so the two cannot drift: each account
 * is refreshed on the scope its own auth type needs, and a failure is only written against
 * the account when Microsoft rejected the grant twice. A batch catches every network hiccup
 * and every throttled reply at once, which is how a panel full of working accounts ended up
 * wearing warning badges.
 */
export async function refreshAccounts(targets: Account[]): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (account) => {
        try {
          const token = await exchangeRefreshToken(
            account.refreshToken,
            account.clientId,
            refreshScopeFor(account.authType),
          );
          recordRefresh(account.id, token.refreshToken, null);
          noteAccountSuccess(account.id);
          results.push({ id: account.id, email: account.email, ok: true });
        } catch (error) {
          const detail =
            error instanceof OAuthError
              ? error.details.slice(0, 500)
              : error instanceof Error
                ? error.message
                : String(error);
          if (isGrantFailure(error) && noteAccountFailure(account.id)) {
            recordRefresh(account.id, null, detail);
          }
          results.push({ id: account.id, email: account.email, ok: false, error: detail });
        }
      }),
    );
  }

  return results;
}
