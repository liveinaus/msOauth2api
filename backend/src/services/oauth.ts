import type { AuthType, TokenSet } from "../types";
import { fetchWithTimeout } from "./http";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const GRAPH_MAIL_READ = "https://graph.microsoft.com/Mail.Read";

/**
 * Scopes for accounts on the older IMAP permission, one per transport.
 *
 * Their consent never covered Graph, so the default grant comes back without anything that
 * will authenticate a Graph call -- the permission has to be asked for by name.
 * `offline_access` is what keeps a refresh token coming back, without which the account
 * would work once and then go stale.
 *
 * Reading and sending are asked for separately because they are separate consented
 * permissions: a token scoped for IMAP does not authenticate an SMTP session (Outlook
 * answers 535), so send fetches its own SMTP.Send token. The refresh token is not scope-
 * locked, so the one stored against the account redeems for either.
 */
const IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";
const SMTP_SCOPE = "https://outlook.office.com/SMTP.Send offline_access";

/** Thrown when Microsoft rejects the refresh token, carrying its status for the response. */
export class OAuthError extends Error {
  readonly status: number;
  readonly details: string;

  constructor(status: number, details: string) {
    super(`Microsoft token endpoint returned ${status}`);
    this.name = "OAuthError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Exchanges a refresh token for an access token.
 *
 * `scope` is what decides which transport a caller ends up on. Asking for
 * `https://graph.microsoft.com/.default` returns a Graph-capable token when the
 * registration allows it; asking for nothing returns the token that IMAP/SMTP XOAUTH2
 * wants. The two are not interchangeable, which is why the callers below are explicit.
 */
export async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  scope?: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (scope) body.set("scope", scope);

  const response = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    "Microsoft token endpoint",
  );

  const raw = await response.text();
  if (!response.ok) throw new OAuthError(response.status, raw);

  let data: { access_token?: string; refresh_token?: string; scope?: string };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new OAuthError(response.status, `Malformed JSON from token endpoint: ${raw}`);
  }

  if (!data.access_token) {
    throw new OAuthError(response.status, `Token response carried no access_token: ${raw}`);
  }

  return {
    accessToken: data.access_token,
    // Microsoft rolls the refresh token on most grants. Returning null rather than the old
    // value lets callers tell "unchanged" from "replaced" and persist only the latter.
    refreshToken: data.refresh_token ?? null,
    scope: data.scope ?? "",
  };
}

/**
 * Token-endpoint error codes that mean "this account was never consented to Graph", as
 * opposed to a dead token. An account with no Graph permission at all has its `.default`
 * request rejected outright rather than answered with a Graph-less scope list, so the probe
 * throws where it would otherwise have reported `available: false`. Treating these as
 * "Graph unavailable" lets such an account fall through to IMAP instead of erroring.
 */
const GRAPH_CONSENT_ERROR_CODES = ["AADSTS90023", "AADSTS65001", "AADSTS70011"];

export function isGraphConsentFailure(error: unknown): boolean {
  return (
    error instanceof OAuthError &&
    GRAPH_CONSENT_ERROR_CODES.some((code) => error.details.includes(code))
  );
}

/**
 * Token-endpoint answers that say nothing about the grant.
 *
 * Microsoft replies 429 while it is throttling and 5xx while it is having a bad minute, and
 * names the condition in the payload when it does. None of that means the refresh token is
 * dead, so none of it should be written against the account: a recorded fault is what puts
 * the warning badge on the row and takes the address out of the pool.
 */
const TRANSIENT_TOKEN_DETAILS = [
  "temporarily_unavailable",
  "server_error",
  "AADSTS90033", // transient service error, retry later
  "AADSTS50196", // request loop / server-side throttle
  "AADSTS90014", // missing field on a truncated request
];

/**
 * Whether a failure is proof that the account itself is broken.
 *
 * Deliberately narrow: only Microsoft rejecting the grant counts. A timeout, a dropped
 * connection or a throttled endpoint is a bad moment, and marking an account for one is the
 * false alarm this guards against -- it is far cheaper to fail a request and let the caller
 * ask again than to quietly retire a working mailbox.
 */
export function isGrantFailure(error: unknown): boolean {
  if (!(error instanceof OAuthError)) return false;
  if (error.status === 429 || error.status >= 500) return false;
  return !TRANSIENT_TOKEN_DETAILS.some((detail) => error.details.includes(detail));
}

export type GraphProbe = { available: boolean; accessToken: string; refreshToken: string | null };

/**
 * Asks for a Graph token and reports whether the one that came back can actually read
 * mail. The granted scope is the only reliable signal here: the endpoint issues a token
 * for `.default` regardless, and it is the scope list that says whether Mail.Read was
 * among the consented permissions.
 */
export async function probeGraphAccess(
  refreshToken: string,
  clientId: string,
): Promise<GraphProbe> {
  const token = await exchangeRefreshToken(
    refreshToken,
    clientId,
    "https://graph.microsoft.com/.default",
  );
  return {
    available: token.scope.includes(GRAPH_MAIL_READ),
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
  };
}

/** Access token for IMAP/SMTP XOAUTH2, which needs the default (non-Graph) grant. */
export async function getMailAccessToken(
  refreshToken: string,
  clientId: string,
): Promise<TokenSet> {
  return exchangeRefreshToken(refreshToken, clientId);
}

/** Read access token for an account whose consent only covers the older IMAP permission. */
export async function getImapAccessToken(
  refreshToken: string,
  clientId: string,
): Promise<TokenSet> {
  return exchangeRefreshToken(refreshToken, clientId, IMAP_SCOPE);
}

/** Send access token for such an account: SMTP.Send, which the IMAP grant does not carry. */
export async function getSmtpAccessToken(
  refreshToken: string,
  clientId: string,
): Promise<TokenSet> {
  return exchangeRefreshToken(refreshToken, clientId, SMTP_SCOPE);
}

/**
 * The scope a plain token refresh should ask for, so the reply carries a replacement the
 * account can actually use next time. An "imap" account refreshed on the default grant
 * would get a token back, but not one its next mail read could authenticate with.
 */
export function refreshScopeFor(authType: AuthType): string | undefined {
  return authType === "imap" ? IMAP_SCOPE : undefined;
}
