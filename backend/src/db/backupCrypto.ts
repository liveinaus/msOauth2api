/**
 * Passphrase protection for the backup file.
 *
 * The document holds every refresh token and mailbox password in the clear, so on its own
 * it is as good as the database. Encrypting it under a passphrase the operator types means
 * the file can be moved between machines, mailed, or left on a disk without being a
 * standing compromise.
 *
 * Deliberately independent of MSAPI_DATA_KEY: that key belongs to one instance, and the
 * whole point of a backup is to restore onto another one. AES-256-GCM over the serialised
 * document, with the key stretched by scrypt so a human-chosen passphrase is not brute
 * forced at the speed of a hash.
 */
import crypto from "node:crypto";
import { BackupError } from "./backup";

export const ENCRYPTED_FORMAT = "msoauth2api.backup.encrypted";
export const ENCRYPTED_VERSION = 1;

/** Short passphrases are the failure mode this feature exists to avoid, so they are refused. */
export const MIN_PASSPHRASE = 8;

// N above the default 16384 needs maxmem raised with it: 128 * N * r is the working set,
// which at these parameters is about 33 MB against a 32 MB default ceiling.
type ScryptParams = { N: number; r: number; p: number; keyLength: number; maxmem: number };

const SCRYPT: ScryptParams = { N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 96 * 1024 * 1024 };

export type EncryptedBackup = {
  format: string;
  version: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

export function isEncryptedBackup(value: unknown): value is EncryptedBackup {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { format?: unknown }).format === ENCRYPTED_FORMAT
  );
}

function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams = SCRYPT): Buffer {
  return crypto.scryptSync(passphrase.normalize("NFKC"), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

export function encryptBackup(document: unknown, passphrase: string): EncryptedBackup {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new BackupError(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final()]);

  return {
    format: ENCRYPTED_FORMAT,
    version: ENCRYPTED_VERSION,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
  };
}

/**
 * Reverses encryptBackup.
 *
 * The KDF parameters come from the file rather than from these constants, so a backup taken
 * today still opens if the defaults are raised later.
 */
export function decryptBackup(envelope: unknown, passphrase: string): unknown {
  if (!isEncryptedBackup(envelope)) throw new BackupError("This file is not an encrypted backup");
  if (!passphrase) throw new BackupError("This backup is protected. Enter its passphrase.");

  const version = typeof envelope.version === "number" ? envelope.version : 0;
  if (version > ENCRYPTED_VERSION) {
    throw new BackupError(
      `Encrypted backup version ${version} is newer than this build understands. Upgrade first.`,
    );
  }

  const kdf = envelope.kdf;
  if (!kdf || kdf.name !== "scrypt" || typeof kdf.salt !== "string") {
    throw new BackupError("Backup is missing its key derivation details");
  }
  if (envelope.cipher !== "aes-256-gcm") {
    throw new BackupError(`Unsupported cipher: ${String(envelope.cipher)}`);
  }

  const salt = Buffer.from(kdf.salt, "base64");
  const iv = Buffer.from(String(envelope.iv), "base64");
  const tag = Buffer.from(String(envelope.tag), "base64");
  const body = Buffer.from(String(envelope.data), "base64");
  if (!salt.length || iv.length !== 12 || tag.length !== 16) {
    throw new BackupError("Backup file is malformed");
  }

  const key = deriveKey(passphrase, salt, {
    N: typeof kdf.N === "number" ? kdf.N : SCRYPT.N,
    r: typeof kdf.r === "number" ? kdf.r : SCRYPT.r,
    p: typeof kdf.p === "number" ? kdf.p : SCRYPT.p,
    keyLength: SCRYPT.keyLength,
    maxmem: SCRYPT.maxmem,
  });

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  let plain: string;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // GCM covers the whole document, so this is either the wrong passphrase or a file that
    // has been altered. The first is overwhelmingly more likely, and the fix differs.
    throw new BackupError("Wrong passphrase, or the file has been altered");
  }

  try {
    return JSON.parse(plain);
  } catch {
    throw new BackupError("Backup contents are not valid JSON");
  }
}
