import crypto from "node:crypto";

/**
 * Optional encryption at rest for the stored account secrets: the Microsoft refresh
 * tokens and mail passwords. Without MSAPI_DATA_KEY these are stored verbatim, which is
 * upstream's behaviour; with it, a copy of the SQLite file is no longer a copy of every
 * mailbox.
 *
 * AES-256-GCM, one random IV per value, key derived once with scrypt so an operator can
 * use a passphrase rather than exactly 32 bytes. Ciphertext is tagged with a version
 * prefix so plain-text rows written before the key was set stay readable and get
 * encrypted the next time they are saved.
 */

const PREFIX = "enc:v1:";
const SALT = "msoauth2api.data.key.v1";

let cachedKey: Buffer | null | undefined;

function dataKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.MSAPI_DATA_KEY?.trim();
  cachedKey = raw ? crypto.scryptSync(raw, SALT, 32) : null;
  return cachedKey;
}

export function encryptionEnabled(): boolean {
  return dataKey() !== null;
}

/** True when the stored value is ciphertext rather than a plain-text row predating the key. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypts when a key is configured; returns the value untouched when not. */
export function encryptSecret(value: string): string {
  const key = dataKey();
  if (!key || value === "") return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

/**
 * Reverses encryptSecret. A value without the prefix predates the key and is returned
 * as-is, which is what makes turning encryption on a non-destructive change.
 */
export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) return value;

  const key = dataKey();
  if (!key) {
    throw new Error(
      "This database holds encrypted values but MSAPI_DATA_KEY is not set. Restore the key to read them.",
    );
  }

  const packed = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const body = packed.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // GCM authentication failed, which in practice means the key changed rather than
    // that the row is corrupt. Say so, because the fix is different.
    throw new Error("Could not decrypt a stored secret: MSAPI_DATA_KEY does not match.");
  }
}
