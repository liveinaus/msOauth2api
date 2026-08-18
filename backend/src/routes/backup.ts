import { Router } from "express";
import { BackupError, exportBackup, importBackup, parseBackup } from "../db/backup";
import {
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
  MIN_PASSPHRASE,
} from "../db/backupCrypto";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

function fail(res: import("express").Response, error: unknown, where: string): void {
  if (error instanceof BackupError) {
    res.status(400).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[backup:${where}]`, error);
  res.status(500).json({ error: message });
}

/**
 * The whole panel as one JSON document.
 *
 * POST rather than GET because of the passphrase: a query string is written to access logs,
 * proxy logs and browser history, which is the one place the key protecting every refresh
 * token must not appear.
 *
 * Without a passphrase the file is plain text and readable by anyone who gets hold of it.
 * That is allowed, since an operator may be writing to an already-encrypted volume, but the
 * caller has to ask for it: `unprotected` must be sent explicitly, so it cannot happen by
 * a slip of a script.
 */
router.post("/export", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";

  try {
    if (!passphrase && body.unprotected !== true) {
      throw new BackupError(
        "This backup would be unencrypted. Send a passphrase, or unprotected: true to accept that.",
      );
    }
    if (passphrase && passphrase.length < MIN_PASSPHRASE) {
      throw new BackupError(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    }

    const backup = exportBackup();
    const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
    const document = passphrase ? encryptBackup(backup, passphrase) : backup;
    const name = passphrase
      ? `msoauth2api-backup-${stamp}.protected.json`
      : `msoauth2api-backup-${stamp}.json`;

    res
      .type("application/json")
      .attachment(name)
      .send(JSON.stringify(document, null, 2));
  } catch (error) {
    fail(res, error, "export");
  }
});

/**
 * Restores one.
 *
 * Body is `{ backup, passphrase, mode, includeAdmin }`, or the backup document on its own
 * for a plain `curl -d @file`. `mode` defaults to "merge"; "replace" empties the accounts,
 * types and keys first, so the panel ends up an exact copy of the source, row ids included.
 */
router.post("/import", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bare = body.format !== undefined;
  const document = bare ? body : body.backup;
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";

  try {
    const opened = isEncryptedBackup(document) ? decryptBackup(document, passphrase) : document;

    const { backup, skipped } = parseBackup(opened);
    const report = importBackup(
      backup,
      {
        mode: body.mode === "replace" ? "replace" : "merge",
        includeAdmin: body.includeAdmin === true,
      },
      skipped,
    );
    res.json(report);
  } catch (error) {
    fail(res, error, "import");
  }
});

export default router;
