import type { Request } from "express";
import type { Mailbox } from "../types";
import { getAccountByEmail } from "../db/accounts";
import type { MailCredentials } from "../services/mail";

/**
 * Upstream read parameters from the query string on GET and the body on everything else,
 * and every endpoint re-implemented that. Both are merged here instead, so a POST may also
 * carry query parameters without surprising anyone.
 */
export function readParams(req: Request): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of [req.query, req.body]) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value === "string") merged[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") merged[key] = String(value);
    }
  }
  return merged;
}

const ALLOWED_MAILBOXES: Mailbox[] = ["INBOX", "Junk"];

/**
 * Only the two folders upstream allowed. This is a real check rather than cosmetic: the
 * value reaches an IMAP SELECT, so an arbitrary folder name would let a caller read parts
 * of a mailbox the API was never meant to expose.
 */
export function parseMailbox(value: string | undefined): Mailbox | null {
  return ALLOWED_MAILBOXES.includes(value as Mailbox) ? (value as Mailbox) : null;
}

export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

/**
 * Resolves the credentials for a request.
 *
 * Upstream required refresh_token and client_id on every call. That still works unchanged,
 * but because this build has a database, naming a stored account is enough: passing just
 * `email` looks the rest up. Explicit parameters always win, so existing callers behave
 * exactly as before.
 *
 * `requireEmail` is false for the token-refresh endpoint, which upstream let callers use
 * with only a token and a client id -- an address is meaningless there, since nothing is
 * connected to a mailbox. The mail and send endpoints do need one, because IMAP and SMTP
 * authenticate as a specific user.
 */
export function resolveCredentials(
  params: Record<string, string>,
  options: { requireEmail?: boolean } = {},
): MailCredentials {
  const requireEmail = options.requireEmail ?? true;
  const email = params.email?.trim() ?? "";
  const refreshToken = params.refresh_token?.trim();
  const clientId = params.client_id?.trim();

  if (refreshToken && clientId) {
    if (requireEmail && !email) throw new ParamError("Missing required parameter: email");
    return { email, clientId, refreshToken };
  }

  if (!email) {
    throw new ParamError("Missing required parameters: refresh_token, client_id");
  }

  const stored = getAccountByEmail(email);
  if (!stored) {
    throw new ParamError(
      "Missing required parameters: refresh_token and client_id (and no stored account matches that email)",
    );
  }
  if (stored.disabled) throw new ParamError(`Account ${email} is disabled`);

  return {
    email: stored.email,
    clientId: clientId || stored.clientId,
    refreshToken: refreshToken || stored.refreshToken,
  };
}

/** Clamps a caller-supplied count into something a mail server will not choke on. */
export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
