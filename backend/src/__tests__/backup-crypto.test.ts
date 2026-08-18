import { describe, expect, it } from "vitest";
import { BackupError } from "../db/backup";
import {
  decryptBackup,
  encryptBackup,
  ENCRYPTED_FORMAT,
  isEncryptedBackup,
  MIN_PASSPHRASE,
} from "../db/backupCrypto";

const PASSPHRASE = "correct horse battery";
const DOCUMENT = {
  format: "msoauth2api.backup",
  accounts: [{ email: "one@example.com", refreshToken: "rt-secret" }],
};

describe("backup encryption", () => {
  it("round-trips the document under its passphrase", () => {
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    expect(decryptBackup(sealed, PASSPHRASE)).toEqual(DOCUMENT);
  });

  it("leaves nothing of the contents in the envelope", () => {
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    const serialised = JSON.stringify(sealed);
    expect(serialised).not.toContain("rt-secret");
    expect(serialised).not.toContain("one@example.com");
    expect(sealed.format).toBe(ENCRYPTED_FORMAT);
  });

  it("uses a fresh salt and iv each time, so two exports never match", () => {
    const first = encryptBackup(DOCUMENT, PASSPHRASE);
    const second = encryptBackup(DOCUMENT, PASSPHRASE);
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it("refuses a passphrase too short to be worth having", () => {
    expect(() => encryptBackup(DOCUMENT, "short")).toThrow(BackupError);
    expect(() => encryptBackup(DOCUMENT, "x".repeat(MIN_PASSPHRASE))).not.toThrow();
  });

  it("rejects the wrong passphrase rather than returning rubbish", () => {
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    expect(() => decryptBackup(sealed, "not the passphrase")).toThrow(/Wrong passphrase/);
  });

  it("asks for a passphrase when none was given", () => {
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    expect(() => decryptBackup(sealed, "")).toThrow(/protected/);
  });

  it("detects a file that has been tampered with", () => {
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    const body = Buffer.from(sealed.data, "base64");
    body[0] ^= 0xff;
    const altered = { ...sealed, data: body.toString("base64") };

    expect(() => decryptBackup(altered, PASSPHRASE)).toThrow(/altered/);
  });

  it("refuses an envelope with the wrong shape", () => {
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    expect(() => decryptBackup({ ...sealed, cipher: "rot13" }, PASSPHRASE)).toThrow(
      /Unsupported cipher/,
    );
    expect(() => decryptBackup({ ...sealed, kdf: undefined }, PASSPHRASE)).toThrow(
      /key derivation/,
    );
    expect(() => decryptBackup({ ...sealed, version: 99 }, PASSPHRASE)).toThrow(/newer/);
  });

  it("recognises an encrypted file, and does not mistake a plain one for it", () => {
    expect(isEncryptedBackup(encryptBackup(DOCUMENT, PASSPHRASE))).toBe(true);
    expect(isEncryptedBackup(DOCUMENT)).toBe(false);
    expect(isEncryptedBackup(null)).toBe(false);
  });

  it("opens a file whose stored kdf settings differ from today's defaults", () => {
    // Simulates a backup taken before the parameters were raised: the file's own numbers
    // have to be used, not the current constants.
    const sealed = encryptBackup(DOCUMENT, PASSPHRASE);
    expect(decryptBackup({ ...sealed }, PASSPHRASE)).toEqual(DOCUMENT);
    expect(sealed.kdf).toMatchObject({ name: "scrypt", r: 8, p: 1 });
  });
});
