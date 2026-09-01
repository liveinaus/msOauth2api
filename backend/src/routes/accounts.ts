import { Router } from "express";
import {
  adjustPriority,
  deleteAccounts,
  getAccount,
  listAccounts,
  markCopied,
  clearRefreshError,
  nextTopPriority,
  normaliseEmail,
  recordRefresh,
  recordUsage,
  setAuthType,
  setPriority,
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
import { ImapTemporaryError, ImapUnavailableError } from "../services/imap";
import { forgetAccount, noteAccountFailure, noteAccountSuccess } from "../services/accountHealth";
import { pickForPanel, readFolders } from "../services/mail";
import { isGrantFailure, OAuthError } from "../services/oauth";
import { refreshAccounts } from "../services/tokenRefresh";
import { findForType, rulesFor } from "../services/typeRules";
import { noteUsage } from "../services/usage";
import {
  AUTH_TYPES,
  DEFAULT_ACCOUNT_SORT,
  DEFAULT_SORT_DIR,
  parseAccountSort,
  parseAuthType,
  parsePriority,
  parseSortDir,
  type Account,
  type AuthType,
} from "../types";

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
    priority: account.priority,
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

/** The public view of one account by id, for endpoints that report back what they changed. */
function publicById(id: number) {
  const account = getAccount(id);
  return account ? toPublic(account) : null;
}

/**
 * `sort` and `dir` are read here rather than sorted in the browser so the order is the
 * server's: the panel pages the list, and a page taken from a differently ordered list is a
 * different set of rows. Anything unrecognised falls back to the default rather than
 * erroring, so a stale bookmark still renders.
 */
router.get("/", (req, res) => {
  const sort = parseAccountSort(req.query.sort) ?? DEFAULT_ACCOUNT_SORT;
  const dir = parseSortDir(req.query.dir) ?? DEFAULT_SORT_DIR;
  // One query for every account's usage rows, rather than one per row.
  const usages = listUsagesByAccount();
  res.json(listAccounts(sort, dir).map((account) => toPublic(account, usages[account.id] ?? [])));
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
    email: normaliseEmail(email),
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
 * Reads what the exporter writes after the four required fields: a protocol name in the
 * fifth position, then `priority`, `remark` and `disabled` as labelled `key=value` fields
 * in any order.
 *
 * Labelled rather than positional because a real file's own trailing columns have to stay
 * ignorable -- reading column six as a priority would let stray data rewrite the queue.
 * Anything unlabelled, or labelled with something else, is skipped as before.
 */
function parseTailFields(fields: string[]): {
  authType?: AuthType;
  priority?: number;
  remark?: string;
  disabled?: boolean;
} {
  const tail: { authType?: AuthType; priority?: number; remark?: string; disabled?: boolean } = {
    authType: parseAuthType(fields[4]) ?? undefined,
  };

  for (const field of fields.slice(4)) {
    const at = field.indexOf("=");
    if (at === -1) continue;
    const key = field.slice(0, at).trim().toLowerCase();
    const value = field.slice(at + 1).trim();
    if (key === "priority" && value) tail.priority = parsePriority(Number(value)) ?? undefined;
    else if (key === "remark") tail.remark = value;
    else if (key === "disabled") tail.disabled = value === "1" || value.toLowerCase() === "true";
  }
  return tail;
}

/** Keeps free text inside one field: a newline or the delimiter would split the record. */
function oneLine(value: string, sep: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .split(sep)
    .join(" ")
    .trim();
}

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
 *
 * Only the first four fields are part of the format, so a fifth field is read as the auth
 * type when it names one and otherwise ignored, along with any further fields. Real files
 * carry trailing columns of their own, and losing a whole account over one is not worth it.
 * The rest of an account -- priority, remark, disabled -- rides in labelled `key=value`
 * fields after those, which is what the exporter writes; see parseTailFields.
 *
 * `useFirst` lands the whole file one step above everything already in the pool, which is
 * what a fresh batch is usually for. It is off by default here so an existing script keeps
 * importing at the normal rank; the panel asks the question and sends an answer either way.
 * Asking for it is a decision about this import, so it beats a priority written in the file.
 */
router.post("/import", (req, res) => {
  const { content, delimiter, authType, useFirst } = req.body ?? {};
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  if (authType !== undefined && parseAuthType(authType) === null) {
    res.status(400).json({ error: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    return;
  }
  if (useFirst !== undefined && typeof useFirst !== "boolean") {
    res.status(400).json({ error: "useFirst must be a boolean" });
    return;
  }
  const sep = typeof delimiter === "string" && delimiter ? delimiter : "----";
  const fileAuthType = parseAuthType(authType) ?? undefined;
  // Read before the first line is written, so every account in the file shares one rank.
  const priority = useFirst === true ? nextTopPriority() : undefined;

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

    const [rawEmail, password, clientId, refreshToken] = fields;
    // Normalised with the row it keys, so a file written in mixed case updates the address
    // the panel already holds instead of adding a second row for the same mailbox.
    const email = rawEmail ? normaliseEmail(rawEmail) : rawEmail;
    if (!email || !clientId || !refreshToken) {
      errors.push({
        line: index + 1,
        reason: "email, clientId and refreshToken must be non-empty",
      });
      return;
    }

    const tail = parseTailFields(fields);
    const account = upsertAccount({
      email,
      password: password || null,
      clientId,
      refreshToken,
      authType: tail.authType ?? fileAuthType,
      priority: priority ?? tail.priority,
      remark: tail.remark,
    });
    // Not part of the upsert: a line that says nothing about it must leave a disabled
    // account disabled rather than quietly putting it back in the pool.
    if (tail.disabled !== undefined && tail.disabled !== account.disabled) {
      updateAccount(account.id, { disabled: tail.disabled });
    }
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
 *
 * Everything else the panel lets you set on an account -- its place in the queue, its remark
 * and whether it is switched off -- follows as labelled fields, and only when it has moved
 * off the default, so an ordinary pool still exports as the plain five-field file other
 * tools expect. What is not here is history rather than settings (when an address was last
 * used, and what it was used for); the JSON backup carries that.
 */
router.get("/export", (req, res) => {
  const sep =
    typeof req.query.delimiter === "string" && req.query.delimiter ? req.query.delimiter : "----";
  const body = listAccounts()
    .map((a) => {
      const fields = [a.email, a.password ?? "", a.clientId, a.refreshToken, a.authType];
      if (a.priority !== 0) fields.push(`priority=${a.priority}`);
      if (a.remark) fields.push(`remark=${oneLine(a.remark, sep)}`);
      if (a.disabled) fields.push("disabled=1");
      return fields.join(sep);
    })
    .join("\n");

  res.type("text/plain").attachment("accounts.txt").send(body);
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { email, password, clientId, refreshToken, authType, priority, remark, disabled } =
    req.body ?? {};

  if (authType !== undefined && parseAuthType(authType) === null) {
    res.status(400).json({ error: `authType must be one of: ${AUTH_TYPES.join(", ")}` });
    return;
  }
  if (priority !== undefined && parsePriority(priority) === null) {
    res.status(400).json({ error: "priority must be a number" });
    return;
  }

  const updated = updateAccount(id, {
    priority: priority === undefined ? undefined : (parsePriority(priority) ?? undefined),
    email: typeof email === "string" ? normaliseEmail(email) : undefined,
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
    // The mailbox answered, which is better proof that the account works than a token
    // refresh is: any fault left over from a bad minute goes now, badge and all.
    noteAccountSuccess(id);
    clearRefreshError(id);
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
      // Only a rejected grant is the account's fault, and only once it has repeated. A
      // throttled or unwell token endpoint is neither, so it fails the request and nothing
      // more.
      if (isGrantFailure(error) && noteAccountFailure(id)) {
        recordRefresh(id, null, error.details.slice(0, 500));
      }
      res.status(error.status).json({ error: "Refresh token failed", details: error.details });
      return;
    }
    if (error instanceof ImapUnavailableError) {
      // Recorded like a refresh failure because it has the same consequence: this mailbox
      // cannot be read. That puts a reason on the status badge and takes the address out of
      // the pool, instead of leaving every poll and every handout to fail the same way.
      // Once it has said so twice: Outlook's wording is clear, but not clear enough to
      // retire an address on a single answer.
      if (noteAccountFailure(id)) {
        recordRefresh(id, null, `${error.message}: ${error.detail}`.slice(0, 500));
      }
      console.warn(`[accounts:latest-mail] ${account.email}: ${error.detail}`);
      res.status(502).json({
        error: error.message,
        details: error.detail,
        // Non-null: read at the top of this handler.
        account: toPublic(getAccount(id)!),
      });
      return;
    }
    if (error instanceof ImapTemporaryError) {
      // Nothing recorded: the mailbox was reachable and only slow, and marking it would
      // take a working address out of the pool over a bad minute. 503 tells the panel poll
      // to keep going rather than treating this as a dead account.
      console.warn(`[accounts:latest-mail] ${account.email} slow to answer: ${error.detail}`);
      res
        .status(503)
        .set("Retry-After", "5")
        .json({
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

/**
 * Moves a selection up or down the pool's queue.
 *
 * `delta` is the panel's bump buttons, `priority` an outright set for putting a batch back
 * to normal. Both are accepted on one endpoint because they are the same edit, and the
 * updated rows come back so the caller does not have to reload the list to see where they
 * landed.
 */
router.post("/priority", (req, res) => {
  const { ids, delta, priority } = req.body ?? {};
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number")) {
    res.status(400).json({ error: "ids must be an array of numbers" });
    return;
  }

  if (delta !== undefined) {
    const step = parsePriority(delta);
    if (step === null) {
      res.status(400).json({ error: "delta must be a number" });
      return;
    }
    const updated = adjustPriority(ids as number[], step);
    res.json({ updated, accounts: (ids as number[]).map(publicById).filter(Boolean) });
    return;
  }

  const value = parsePriority(priority);
  if (value === null) {
    res.status(400).json({ error: "delta or priority is required" });
    return;
  }
  const updated = setPriority(ids as number[], value);
  res.json({ updated, accounts: (ids as number[]).map(publicById).filter(Boolean) });
});

router.post("/delete", (req, res) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number")) {
    res.status(400).json({ error: "ids must be an array of numbers" });
    return;
  }
  (ids as number[]).forEach(forgetAccount);
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

  const results = await refreshAccounts(targets);

  res.json({
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

export default router;
