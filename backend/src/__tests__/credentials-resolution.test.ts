import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/database";
import { upsertAccount } from "../db/accounts";
import { ParamError, resolveCredentials } from "../routes/params";

describe("resolveCredentials", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM accounts").run();
  });

  it("passes explicit upstream parameters straight through", () => {
    expect(resolveCredentials({ email: "a@x.com", refresh_token: "rt", client_id: "cid" })).toEqual(
      { email: "a@x.com", clientId: "cid", refreshToken: "rt", authType: "auto" },
    );
  });

  it("allows the refresh endpoint to omit the address, as upstream did", () => {
    expect(
      resolveCredentials({ refresh_token: "rt", client_id: "cid" }, { requireEmail: false }),
    ).toEqual({ email: "", clientId: "cid", refreshToken: "rt", authType: "auto" });
  });

  it("still demands an address on the mail endpoints", () => {
    expect(() => resolveCredentials({ refresh_token: "rt", client_id: "cid" })).toThrow(ParamError);
  });

  it("looks a stored account up when only an address is given", () => {
    upsertAccount({ email: "b@x.com", password: "pw", clientId: "cid-b", refreshToken: "rt-b" });

    expect(resolveCredentials({ email: "b@x.com" })).toEqual({
      email: "b@x.com",
      clientId: "cid-b",
      refreshToken: "rt-b",
      authType: "auto",
    });
  });

  it("carries a stored account's auth type", () => {
    upsertAccount({
      email: "imap@x.com",
      password: null,
      clientId: "cid-i",
      refreshToken: "rt-i",
      authType: "imap",
    });

    expect(resolveCredentials({ email: "imap@x.com" }).authType).toBe("imap");
  });

  it("lets an explicit auth_type override the stored one", () => {
    upsertAccount({ email: "e@x.com", password: null, clientId: "cid-e", refreshToken: "rt-e" });

    expect(resolveCredentials({ email: "e@x.com", auth_type: "imap" }).authType).toBe("imap");
  });

  it("defaults to auto for credentials passed without an auth type", () => {
    expect(
      resolveCredentials({ email: "f@x.com", refresh_token: "rt", client_id: "cid" }).authType,
    ).toBe("auto");
  });

  it("ignores an unrecognised auth_type rather than failing the read", () => {
    upsertAccount({
      email: "g@x.com",
      password: null,
      clientId: "cid-g",
      refreshToken: "rt-g",
      authType: "imap",
    });

    expect(resolveCredentials({ email: "g@x.com", auth_type: "pop3" }).authType).toBe("imap");
  });

  it("lets an explicit token override the stored one", () => {
    upsertAccount({ email: "c@x.com", password: null, clientId: "cid-c", refreshToken: "rt-c" });

    expect(resolveCredentials({ email: "c@x.com", refresh_token: "override" }).refreshToken).toBe(
      "override",
    );
  });

  it("refuses a disabled account", () => {
    upsertAccount({ email: "d@x.com", password: null, clientId: "cid-d", refreshToken: "rt-d" });
    db.prepare("UPDATE accounts SET disabled = 1 WHERE email = ?").run("d@x.com");

    expect(() => resolveCredentials({ email: "d@x.com" })).toThrow(/disabled/);
  });

  it("reports missing parameters when the address is unknown", () => {
    expect(() => resolveCredentials({ email: "nobody@x.com" })).toThrow(ParamError);
  });
});
