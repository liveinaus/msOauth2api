import { Router } from "express";
import {
  deleteAccounts,
  getAccount,
  listAccounts,
  markCopied,
  recordRefresh,
  recordUsage,
  setAuthType,
  updateAccount,
  upsertAccount,
} from "../db/accounts";
import { getPanelSettings } from "../db/panelSettings";
import {
  clearUsage,
  confirmUsage,
  getUsage,
  leaseSpecific,
  listUsages,
  listUsagesByAccount,
  normaliseType,
  type Usage,
} from "../db/usages";
import { requireAuth } from "../middleware/auth";
import { ImapUnavailableError } from "../services/imap";
import { pickForPanel, readFolders } from "../services/mail";
import { exchangeRefreshToken, OAuthError, refreshScopeFor } from "../services/oauth";
import { findForType, rulesFor } from "../services/typeRules";
import { noteUsage } from "../services/usage";
import { AUTH_TYPES, parseAuthType, type Account } from "../types";

const router = Router();

router.use(requireAuth);

/**
 * The panel never needs the refresh token itself, only whether one is present, so it is
 * replaced with a short fingerprint. A token that never reaches the browser cannot leak
 * through the DOM, an extension or a screenshot -- upstream held every token in
 * localStorage and rendered a truncated form into the accounts table.
 */
/**
 * Which types this address has been handed out for. An expired lease is dropped rather than
 * shown: the address is back in the pool, so claiming otherwise in the panel would be a lie.
 */
function usageView(usages: Usage[], now: number) {
  return usages
    .filter((u) => u.confirmedAt !== null || (u.leaseExpiresAt ?? 0) > now)
    .map((u) => ({
      type: u.type,
      leasedAt: u.leasedAt,
      confirmedAt: u.confirmedAt,
      leaseExpiresAt: u.confirmedAt === null ? u.leaseExpiresAt : null,
      code: u.code,
    }));
}

function toPublic(account: Account, usages: Usage[] = listUsages(account.id)) {
  return {
    usages: usageView(usages, Date.now()),
    id: account.id,
    email: account.email,
    clientId: account.clientId,
    authType: account.authType,
    hasPassword: Boolean(account.password),
    tokenHint: `${account.refreshToken.slice(0, 6)}…${account.refreshToken.slice(-4)}`,
    remark: account.remark,
    disabled: account.disabled,
    lastRefreshAt: account.lastRefreshAt,
    lastRefreshError: account.lastRefreshError,
    lastCopiedAt: account.lastCopiedAt,
    lastUsedAt: account.lastUsedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

router.get("/", (_req, res) => {
  // One query for every account's usage rows, rather than one per row.
  const usages = listUsagesByAccount();
  res.json(listAccounts().map((account) => toPublic(account, usages[account.id] ?? [])));
});

router.post("/", (req, res) => {
  const { email, password, clientId, refreshToken, authType, remark } = req.body ?? {};
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  if (typeof clientId !== "string" || !clientId.trim()) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }

  if (authType !== undefined && parseAuthType(authType) === null) {
    res.status(400).json({ error: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    return;
  }

  const account = upsertAccount({
    email: email.trim(),
    password: typeof password === "string" ? password : null,
    clientId: clientId.trim(),
    refreshToken: refreshToken.trim(),
    // A new account with nothing said defaults to "auto" in the database.
    authType: parseAuthType(authType) ?? undefined,
    remark: typeof remark === "string" ? remark : null,
  });
  res.status(201).json(toPublic(account));
});

/**
 * Bulk import.
 *
 * Upstream parsed a delimited file in the browser and appended every line blindly, so a
 * re-import silently doubled the list. Parsing here means one code path, real validation
 * and a per-line report of what was rejected.
 *
 * The auth type can come from either end: a body-level `authType` applies to the whole
 * file, which is how a batch of IMAP-only accounts gets marked in one go, and an optional
 * fifth field on a line overrides it for that account. With neither, an existing account
 * keeps the type it already has and a new one starts on "auto".
 */
router.post("/import", (req, res) => {
  const { content, delimiter, authType } = req.body ?? {};
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  if (authType !== undefined && parseAuthType(authType) === null) {
    res.status(400).json({ error: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    return;
  }
  const sep = typeof delimiter === "string" && delimiter ? delimiter : "----";
  const fileAuthType = parseAuthType(authType) ?? undefined;

  const errors: { line: number; reason: string }[] = [];
  let imported = 0;

  content.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;

    const fields = line.split(sep).map((f) => f.trim());
    if (fields.length < 4) {
      errors.push({ line: index + 1, reason: `expected 4 fields separated by "${sep}"` });
      return;
    }

    const [email, password, clientId, refreshToken, lineAuthType] = fields;
    if (!email || !clientId || !refreshToken) {
      errors.push({
        line: index + 1,
        reason: "email, clientId and refreshToken must be non-empty",
      });
      return;
    }
    if (lineAuthType && parseAuthType(lineAuthType) === null) {
      errors.push({
        line: index + 1,
        reason: `field 5 must be one of: ${AUTH_TYPES.join(", ")}`,
      });
      return;
    }

    upsertAccount({
      email,
      password: password || null,
      clientId,
      refreshToken,
      authType: parseAuthType(lineAuthType) ?? fileAuthType,
    });
    imported++;
  });

  res.json({ imported, failed: errors.length, errors: errors.slice(0, 50) });
});

/**
 * Export in the same delimited format the importer accepts, for backup or migration.
 *
 * The auth type is written as a fifth field so an export round-trips: without it, restoring
 * a backup would put every IMAP-only account back on the Graph-first path. The importer
 * still takes four-field lines, so older files keep working.
 */
router.get("/export", (req, res) => {
  const sep =
    typeof req.query.delimiter === "string" && req.query.delimiter ? req.query.delimiter : "----";
  const body = listAccounts()
    .map((a) => [a.email, a.password ?? "", a.clientId, a.refreshToken, a.authType].join(sep))
    .join("\n");

  res.type("text/plain").attachment("accounts.txt").send(body);
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { email, password, clientId, refreshToken, authType, remark, disabled } = req.body ?? {};

  if (authType !== undefined && parseAuthType(authType) === null) {
    res.status(400).json({ error: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    return;
  }

  const updated = updateAccount(id, {
    email: typeof email === "string" ? email.trim() : undefined,
    password: typeof password === "string" ? password : undefined,
    clientId: typeof clientId === "string" ? clientId.trim() : undefined,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.trim() ? refreshToken.trim() : undefined,
    authType: parseAuthType(authType) ?? undefined,
    remark: typeof remark === "string" ? remark : undefined,
    disabled: typeof disabled === "boolean" ? disabled : undefined,
  });

  if (!updated) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(toPublic(updated));
});

/**
 * Records that the address was copied out of the panel, starting the usage window.
 *
 * With a `type`, the copy is scoped to it: only that type is claimed, and every other one
 * this address might serve is left alone. Without a type the account-wide dates move, which
 * is the behaviour for panels not using the pool at all.
 *
 * Under the "copy" usage mode the copy is itself the whole answer, so the used mark is made
 * here and nothing waits on mail arriving.
 */
router.post("/:id/copied", (req, res) => {
  const id = Number(req.params.id);
  const type = typeof req.body?.type === "string" ? normaliseType(req.body.type) : "";
  const settings = getPanelSettings();

  if (type) {
    const account = getAccount(id);
    if (!account) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    if (settings.usageMode === "copy") confirmUsage(id, type, null);
    else leaseSpecific(id, type, settings.leaseMinutes * 60_000);

    res.json(toPublic(account));
    return;
  }

  const account = markCopied(id);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  if (settings.usageMode === "copy" && account.lastCopiedAt !== null) {
    recordUsage(id, account.lastCopiedAt);
    // Non-null: the row was just updated, so it exists.
    res.json(toPublic(getAccount(id)!));
    return;
  }
  res.json(toPublic(account));
});

/**
 * Marks or unmarks an address as used for a type by hand, for a signup done outside the
 * panel or a mark made in error.
 */
router.post("/:id/usage", (req, res) => {
  const id = Number(req.params.id);
  const account = getAccount(id);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const type = typeof req.body?.type === "string" ? normaliseType(req.body.type) : "";
  if (!type) {
    res.status(400).json({ error: "type is required" });
    return;
  }

  if (req.body?.used === false) clearUsage(id, type);
  else confirmUsage(id, type, null);

  res.json(toPublic(account));
});

/**
 * The newest message for the panel's quick look, across the inbox and the junk folder.
 *
 * Junk is included because a verification mail from a service the mailbox has never heard
 * from is exactly what Outlook filters, and a code sitting in junk is no use to anybody.
 *
 * Separate from /mail-new so the panel does not have to hold or pass credentials, and so
 * the reply carries the account back with its usage date already updated -- the caller
 * would otherwise have to reload the whole list to see the column change.
 */
router.get("/:id/latest-mail", async (req, res) => {
  const id = Number(req.params.id);
  const account = getAccount(id);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  try {
    const type = typeof req.query.type === "string" ? normaliseType(req.query.type) : "";
    // With a type, its sender and subject filters narrow the search and its own pattern
    // reads the code, so the column shows that service's code rather than whatever landed
    // most recently. A few messages are fetched rather than one, since the mail being
    // waited on is not always on top.
    const result = await readFolders(
      {
        email: account.email,
        clientId: account.clientId,
        refreshToken: account.refreshToken,
        authType: account.authType,
      },
      ["INBOX", "Junk"],
      type ? 5 : 1,
    );
    if (result.rotatedRefreshToken) recordRefresh(id, result.rotatedRefreshToken, null);
    noteUsage(account.email, result.messages);

    if (type) {
      const usage = getUsage(id, type);
      const rules = rulesFor(type, { since: usage?.leasedAt });
      const hit = findForType(result.messages, rules);

      // Mail matching this type's rules, after the address was claimed for it, is the proof
      // the address was used for that service.
      if (hit && usage && usage.confirmedAt === null) confirmUsage(id, type, hit.code ?? null);

      res.json({
        message: hit ? { ...hit.message, code: hit.code } : null,
        transport: result.transport,
        // Non-null: read at the top of this handler, and nothing here deletes it.
        account: toPublic(getAccount(id)!),
      });
      return;
    }

    res.json({
      message: pickForPanel(result.messages),
      transport: result.transport,
      // Non-null: the row was read at the top of this handler and nothing deletes it here.
      account: toPublic(getAccount(id)!),
    });
  } catch (error) {
    if (error instanceof OAuthError) {
      recordRefresh(id, null, error.details.slice(0, 500));
      res.status(error.status).json({ error: "Refresh token failed", details: error.details });
      return;
    }
    if (error instanceof ImapUnavailableError) {
      // Recorded like a refresh failure because it has the same consequence: this mailbox
      // cannot be read. That puts a reason on the status badge and takes the address out of
      // the pool, instead of leaving every poll and every handout to fail the same way.
      recordRefresh(id, null, `${error.message}: ${error.detail}`.slice(0, 500));
      console.warn(`[accounts:latest-mail] ${account.email}: ${error.detail}`);
      res.status(502).json({
        error: error.message,
        details: error.detail,
        // Non-null: read at the top of this handler.
        account: toPublic(getAccount(id)!),
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[accounts:latest-mail]", error);
    res.status(500).json({ error: message });
  }
});

/** Marks a set of accounts as being on one grant or the other. */
router.post("/auth-type", (req, res) => {
  const { ids, authType } = req.body ?? {};
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number")) {
    res.status(400).json({ error: "ids must be an array of numbers" });
    return;
  }

  const parsed = parseAuthType(authType);
  if (!parsed) {
    res.status(400).json({ error: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    return;
  }

  res.json({ updated: setAuthType(ids as number[], parsed) });
});

router.post("/delete", (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number")) {
    res.status(400).json({ error: "ids must be an array of numbers" });
    return;
  }
  res.json({ deleted: deleteAccounts(ids as number[]) });
});

/**
 * Batch token refresh.
 *
 * Accounts are refreshed a few at a time: Microsoft throttles the token endpoint, and
 * upstream's browser-side loop fired one request per account with no bound, so a panel with
 * a hundred accounts mostly got rate-limited answers. Failures are recorded per account
 * rather than aborting the run.
 *
 * Each account is refreshed on the scope its own auth type needs: refreshing an IMAP-only
 * account on the default grant would store a replacement token that the next mail read
 * cannot authenticate with.
 */
router.post("/refresh", async (req, res) => {
  const { ids } = req.body ?? {};
  const targets =
    Array.isArray(ids) && ids.length
      ? (ids as number[]).map((id) => getAccount(id)).filter((a): a is Account => Boolean(a))
      : listAccounts().filter((a) => !a.disabled);

  const results: { id: number; email: string; ok: boolean; error?: string }[] = [];
  const CONCURRENCY = 3;

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
          results.push({ id: account.id, email: account.email, ok: true });
        } catch (error) {
          const detail =
            error instanceof OAuthError
              ? error.details.slice(0, 500)
              : error instanceof Error
                ? error.message
                : String(error);
          recordRefresh(account.id, null, detail);
          results.push({ id: account.id, email: account.email, ok: false, error: detail });
        }
      }),
    );
  }

  res.json({
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

export default router;
