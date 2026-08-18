/**
 * Address-pool API for external systems.
 *
 * The flow it serves: ask for an address that has not been used for a type, hand that
 * address to the service being signed up for, then poll for the code it sends. Everything
 * here is guarded by an API key, like the other machine endpoints.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getAccountByEmail, recordRefresh } from "../db/accounts";
import { getPanelSettings } from "../db/panelSettings";
import {
  confirmUsage,
  getUsage,
  leaseAccount,
  listUsages,
  normaliseType,
  poolStats,
  releaseUsage,
} from "../db/usages";
import { requireApiAccess } from "../middleware/auth";
import { ImapUnavailableError } from "../services/imap";
import { findCode, parseSince } from "../services/codeSearch";
import { findForType, rulesFor } from "../services/typeRules";
import { readFolders } from "../services/mail";
import { OAuthError } from "../services/oauth";
import { noteUsage } from "../services/usage";
import { parseLimit, readParams } from "./params";
import type { Account } from "../types";

const router = Router();

const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 50;

/**
 * `account` is passed where one is known, so a fault belonging to that mailbox is recorded
 * against it rather than only logged.
 */
function sendError(res: Response, error: unknown, account?: Account): void {
  if (error instanceof OAuthError) {
    if (account) recordRefresh(account.id, null, error.details.slice(0, 500));
    res.status(error.status).json({ error: "Refresh token failed", details: error.details });
    return;
  }
  if (error instanceof ImapUnavailableError) {
    // Recorded against the account because it does not clear on a retry: that puts the
    // reason on the panel's status badge and, more to the point here, takes the address out
    // of the pool. Without it, get-available-email would keep handing out a mailbox that
    // cannot be read, and every poll against it would fail the same way.
    if (account) recordRefresh(account.id, null, `${error.message}: ${error.detail}`.slice(0, 500));
    console.warn(
      `[integration] ${account?.email ?? "mailbox"} not available over IMAP: ${error.detail}`,
    );
    res.status(502).json({ error: error.message, details: error.detail });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("[integration]", error);
  res.status(500).json({ error: message });
}

/**
 * Every endpoint here names a type; it is the whole basis of the pool.
 *
 * The normalised form is what comes back, so "Telegram", "telegram" and " TELEGRAM " are
 * one type all the way through: the same pool, the same records, and the same spelling in
 * every response a caller has to compare against.
 */
function requireType(params: Record<string, string>, res: Response): string | null {
  const type = params.type?.trim();
  if (!type) {
    res.status(400).json({ error: "type is required" });
    return null;
  }
  return normaliseType(type);
}

/** The optional counterpart, for endpoints where a type narrows the search but is not required. */
function optionalType(params: Record<string, string>): string | undefined {
  const type = params.type?.trim();
  return type ? normaliseType(type) : undefined;
}

function requireStoredAccount(params: Record<string, string>, res: Response): Account | null {
  const email = params.email?.trim();
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return null;
  }
  const account = getAccountByEmail(email);
  if (!account) {
    res.status(404).json({ error: `No stored account for ${email}` });
    return null;
  }
  return account;
}

/**
 * Leases the next address that has not been used for this type.
 *
 * The lease is what stops two callers being handed the same address, and what stops an
 * abandoned signup consuming one for good: it lapses on its own, and only a code (or an
 * explicit confirm) retires the address permanently.
 */
router.get("/get-available-email", requireApiAccess, handleGetAvailable);
router.post("/get-available-email", requireApiAccess, handleGetAvailable);

function handleGetAvailable(req: Request, res: Response): void {
  const params = readParams(req);
  const type = requireType(params, res);
  if (!type) return;

  const leaseMs = getPanelSettings().leaseMinutes * 60_000;
  const result = leaseAccount(type, leaseMs);

  if (!result.ok) {
    const stats = poolStats(type);
    res.status(409).json({
      error: `No address available for type "${type}"`,
      ...stats,
    });
    return;
  }

  res.json({
    email: result.account.email,
    type: result.usage.type,
    leasedAt: result.usage.leasedAt,
    leaseExpiresAt: result.usage.leaseExpiresAt,
    remaining: poolStats(type).available,
  });
}

/**
 * The code for an address, if one has arrived yet.
 *
 * Answers 200 either way, with `status` saying which: a poller wants "not yet" to look
 * different from "that address does not exist", and only the second is an error.
 *
 * Inbox and junk are both searched, since a code from a service the mailbox has never heard
 * from is exactly what Outlook files as junk.
 */
router.get("/get-code", requireApiAccess, handleGetCode);
router.post("/get-code", requireApiAccess, handleGetCode);

async function handleGetCode(req: Request, res: Response): Promise<void> {
  const params = readParams(req);
  const account = requireStoredAccount(params, res);
  if (!account) return;

  const type = optionalType(params);
  const usage = type ? getUsage(account.id, type) : undefined;

  // Default window is the lease: without it, a code left over from a previous run for the
  // same service would be handed back as though it were this run's. Sender and subject fall
  // back to whatever the type is configured with in the panel, and explicit arguments win.
  const rules = rulesFor(type, {
    since: parseSince(params.since) ?? usage?.leasedAt,
    from: params.from?.trim() || undefined,
    subject: params.subject?.trim() || undefined,
  });
  const query = rules.query;

  try {
    const result = await readFolders(
      {
        email: account.email,
        clientId: account.clientId,
        refreshToken: account.refreshToken,
        authType: account.authType,
      },
      ["INBOX", "Junk"],
      parseLimit(params.limit, SEARCH_DEFAULT, SEARCH_MAX),
    );
    noteUsage(account.email, result.messages);

    // A configured type reads the code with its own pattern; without one this is the
    // generic extraction, which is what the endpoint did before types existed.
    const hit = rules.type
      ? findForType(result.messages, rules)
      : (() => {
          const found = findCode(result.messages, query);
          return found ? { message: found, code: found.code } : undefined;
        })();

    if (!hit?.code) {
      res.json({ status: "pending", email: account.email, type: type ?? null, query });
      return;
    }

    // Finding the code is the proof the address was used, so the claim becomes permanent.
    if (type) confirmUsage(account.id, type, hit.code);

    res.json({
      status: "found",
      email: account.email,
      type: type ?? null,
      code: hit.code,
      message: {
        from: hit.message.send,
        subject: hit.message.subject,
        date: hit.message.date,
        mailbox: hit.message.mailbox,
      },
    });
  } catch (error) {
    sendError(res, error, account);
  }
}

/** Retires an address for a type without a code, for a signup confirmed some other way. */
router.post("/confirm-email", requireApiAccess, (req, res) => {
  const params = readParams(req);
  const account = requireStoredAccount(params, res);
  if (!account) return;
  const type = requireType(params, res);
  if (!type) return;

  const usage = confirmUsage(account.id, type, null);
  res.json({ email: account.email, type: usage?.type, confirmedAt: usage?.confirmedAt });
});

/** Hands an address back early. A confirmed address stays retired and is left untouched. */
router.post("/release-email", requireApiAccess, (req, res) => {
  const params = readParams(req);
  const account = requireStoredAccount(params, res);
  if (!account) return;
  const type = requireType(params, res);
  if (!type) return;

  const released = releaseUsage(account.id, type);
  res.json({ email: account.email, type, released });
});

/** What an address has been used for, for debugging an integration. */
router.get("/email-status", requireApiAccess, (req, res) => {
  const params = readParams(req);
  const account = requireStoredAccount(params, res);
  if (!account) return;

  const type = optionalType(params);
  const usages = type
    ? [getUsage(account.id, type)].filter((u): u is NonNullable<typeof u> => Boolean(u))
    : listUsages(account.id);

  res.json({
    email: account.email,
    disabled: account.disabled,
    lastRefreshError: account.lastRefreshError,
    usages: usages.map((u) => ({
      type: u.type,
      leasedAt: u.leasedAt,
      leaseExpiresAt: u.leaseExpiresAt,
      confirmedAt: u.confirmedAt,
      code: u.code,
      codeAt: u.codeAt,
    })),
  });
});

/** Capacity for a type, so a caller can see the pool running low before it runs out. */
router.get("/pool-status", requireApiAccess, (req, res) => {
  const params = readParams(req);
  const type = requireType(params, res);
  if (!type) return;
  res.json(poolStats(type));
});

export default router;
