/**
 * Which token-endpoint failures are the account's fault.
 *
 * The distinction is expensive to get wrong in one direction only: a fault recorded against
 * an account shows a warning badge and takes the address out of the pool until somebody
 * clears it, so a throttled or unwell endpoint must never count as a dead grant.
 */
import { describe, expect, it } from "vitest";
import { isGrantFailure, OAuthError } from "../services/oauth";

describe("isGrantFailure", () => {
  it("counts a rejected grant", () => {
    const error = new OAuthError(
      400,
      '{"error":"invalid_grant","error_description":"AADSTS70000"}',
    );
    expect(isGrantFailure(error)).toBe(true);
  });

  it("does not count a throttled endpoint", () => {
    expect(isGrantFailure(new OAuthError(429, "Too many requests"))).toBe(false);
  });

  it("does not count Microsoft having a bad minute", () => {
    expect(isGrantFailure(new OAuthError(503, "Service Unavailable"))).toBe(false);
    expect(isGrantFailure(new OAuthError(500, "oops"))).toBe(false);
  });

  it("does not count a transient condition named in the payload", () => {
    const error = new OAuthError(400, '{"error":"temporarily_unavailable"}');
    expect(isGrantFailure(error)).toBe(false);
  });

  it("does not count a timeout or a network fault, which never reached the endpoint", () => {
    expect(isGrantFailure(new Error("Microsoft token endpoint did not respond within 30s"))).toBe(
      false,
    );
    expect(isGrantFailure(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))).toBe(
      false,
    );
  });
});
