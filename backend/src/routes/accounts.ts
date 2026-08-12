import { Router } from "express";
import {
  deleteAccounts,
  getAccount,
  listAccounts,
  recordRefresh,
  updateAccount,
  upsertAccount,
} from "../db/accounts";
import { requireAuth } from "../middleware/auth";
import { exchangeRefreshToken, OAuthError } from "../services/oauth";
import type { Account } from "../types";

const router = Router();

router.use(requireAuth);

/**
 * The panel never needs the refresh token itself, only whether one is present, so it is
 * replaced with a short fingerprint. A token that never reaches the browser cannot leak
 * through the DOM, an extension or a screenshot -- upstream held every token in
 * localStorage and rendered a truncated form into the accounts table.
 */
function toPublic(account: Account) {
  return {
    id: account.id,
    email: account.email,
    clientId: account.clientId,
    hasPassword: Boolean(account.password),
    tokenHint: `${account.refreshToken.slice(0, 6)}…${account.refreshToken.slice(-4)}`,
    remark: account.remark,
    disabled: account.disabled,
    lastRefreshAt: account.lastRefreshAt,
    lastRefreshError: account.lastRefreshError,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

router.get("/", (_req, res) => {
  res.json(listAccounts().map(toPublic));
});

router.post("/", (req, res) => {
  const { email, password, clientId, refreshToken, remark } = req.body ?? {};
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

  const account = upsertAccount({
    email: email.trim(),
    password: typeof password === "string" ? password : null,
    clientId: clientId.trim(),
    refreshToken: refreshToken.trim(),
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
 */
router.post("/import", (req, res) => {
  const { content, delimiter } = req.body ?? {};
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  const sep = typeof delimiter === "string" && delimiter ? delimiter : "----";

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

    const [email, password, clientId, refreshToken] = fields;
    if (!email || !clientId || !refreshToken) {
      errors.push({
        line: index + 1,
        reason: "email, clientId and refreshToken must be non-empty",
      });
      return;
    }

    upsertAccount({ email, password: password || null, clientId, refreshToken });
    imported++;
  });

  res.json({ imported, failed: errors.length, errors: errors.slice(0, 50) });
});

/** Export in the same delimited format the importer accepts, for backup or migration. */
router.get("/export", (req, res) => {
  const sep =
    typeof req.query.delimiter === "string" && req.query.delimiter ? req.query.delimiter : "----";
  const body = listAccounts()
    .map((a) => [a.email, a.password ?? "", a.clientId, a.refreshToken].join(sep))
    .join("\n");

  res.type("text/plain").attachment("accounts.txt").send(body);
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { email, password, clientId, refreshToken, remark, disabled } = req.body ?? {};

  const updated = updateAccount(id, {
    email: typeof email === "string" ? email.trim() : undefined,
    password: typeof password === "string" ? password : undefined,
    clientId: typeof clientId === "string" ? clientId.trim() : undefined,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.trim() ? refreshToken.trim() : undefined,
    remark: typeof remark === "string" ? remark : undefined,
    disabled: typeof disabled === "boolean" ? disabled : undefined,
  });

  if (!updated) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(toPublic(updated));
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
          const token = await exchangeRefreshToken(account.refreshToken, account.clientId);
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
