import { blockAccount, recordRefresh } from "../db/accounts";
import type { Account, BlockReason } from "../types";
import { noteAccountFailure, noteAccountSuccess } from "./accountHealth";
import {
  describeOAuthError,
  exchangeRefreshToken,
  isAbuseBlock,
  isGrantFailure,
  OAuthError,
  refreshScopeFor,
} from "./oauth";

export type RefreshResult = {
  id: number;
  email: string;
  ok: boolean;
  error?: string;
  /** Set when this refresh took the account out of the pool. */
  blocked?: BlockReason;
};

/**
 * Microsoft throttles the token endpoint, so a panel's worth of accounts goes a few at a
 * time. Upstream's browser loop fired one unbounded request per account and mostly got
 * rate-limited answers back.
 */
const CONCURRENCY = 3;

/** The line written against a blocked row: Microsoft's own wording, dated. */
function blockNote(detail: string, at: Date): string {
  return `[auto ${at.toISOString().slice(0, 10)}] ${describeOAuthError(detail)}`;
}

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
          // Service abuse mode does not wait for the second failure an ordinary grant
          // rejection needs: the verdict is specific, Microsoft never returns it as a blip,
          // and the mailbox stays gone until it is lifted. Leaving such an address in the
          // pool only spends it on requests that cannot succeed.
          if (isAbuseBlock(error)) {
            recordRefresh(account.id, null, detail);
            // The full body, not the truncated `detail`: a 500-character slice can cut the
            // JSON mid-field, and the description is what ends up on the row.
            blockAccount(account.id, "abuse", blockNote((error as OAuthError).details, new Date()));
            console.warn(`[refresh] ${account.email} disabled: service abuse mode`);
            results.push({
              id: account.id,
              email: account.email,
              ok: false,
              error: detail,
              blocked: "abuse",
            });
            return;
          }
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
