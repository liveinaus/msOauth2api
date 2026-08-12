import type { TokenSet } from "../types";

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const GRAPH_MAIL_READ = "https://graph.microsoft.com/Mail.Read";

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

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

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
