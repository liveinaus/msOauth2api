import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { parseLimit, parseMailbox, readParams } from "../routes/params";

function fakeRequest(method: string, query: unknown, body?: unknown): Request {
  return { method, query, body } as unknown as Request;
}

describe("parseMailbox", () => {
  it("accepts the two allowed folders", () => {
    expect(parseMailbox("INBOX")).toBe("INBOX");
    expect(parseMailbox("Junk")).toBe("Junk");
  });

  it("rejects anything else, including case variants and traversal attempts", () => {
    for (const value of ["inbox", "Sent", "../Sent", "", undefined, "INBOX Junk"]) {
      expect(parseMailbox(value)).toBeNull();
    }
  });
});

describe("readParams", () => {
  it("merges query and body so a POST may carry either", () => {
    const req = fakeRequest("POST", { mailbox: "INBOX" }, { email: "a@x.com" });
    expect(readParams(req)).toEqual({ mailbox: "INBOX", email: "a@x.com" });
  });

  it("lets the body win over the query on a conflict", () => {
    const req = fakeRequest("POST", { mailbox: "INBOX" }, { mailbox: "Junk" });
    expect(readParams(req).mailbox).toBe("Junk");
  });

  it("coerces numbers and drops non-scalar values", () => {
    const req = fakeRequest("GET", { limit: 25, nested: { a: 1 }, list: ["x"] });
    expect(readParams(req)).toEqual({ limit: "25" });
  });

  it("survives a missing body", () => {
    expect(readParams(fakeRequest("GET", { email: "a@x.com" }))).toEqual({ email: "a@x.com" });
  });
});

describe("parseLimit", () => {
  it("uses the fallback for missing or junk values", () => {
    expect(parseLimit(undefined, 100, 1000)).toBe(100);
    expect(parseLimit("abc", 100, 1000)).toBe(100);
    expect(parseLimit("0", 100, 1000)).toBe(100);
    expect(parseLimit("-5", 100, 1000)).toBe(100);
  });

  it("clamps to the maximum so one caller cannot ask for a whole mailbox", () => {
    expect(parseLimit("999999", 100, 1000)).toBe(1000);
  });

  it("passes a sensible value through", () => {
    expect(parseLimit("42", 100, 1000)).toBe(42);
  });
});
