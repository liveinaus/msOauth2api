import { describe, expect, it } from "vitest";
import { findCode, matchesQuery, parseSince } from "../services/codeSearch";
import type { MailMessage } from "../types";

const NOON = Date.parse("2026-08-13T12:00:00Z");

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    send: "noreply@telegram.org",
    subject: "Your login code",
    text: "",
    html: "",
    date: "2026-08-13T12:05:00Z",
    code: "483920",
    ...overrides,
  };
}

describe("parseSince", () => {
  it("accepts epoch milliseconds and ISO timestamps alike", () => {
    expect(parseSince(String(NOON))).toBe(NOON);
    expect(parseSince("2026-08-13T12:00:00Z")).toBe(NOON);
  });

  it("returns undefined for nothing, or for something unparseable", () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("")).toBeUndefined();
    expect(parseSince("whenever")).toBeUndefined();
  });
});

describe("matchesQuery", () => {
  it("keeps mail at or after the window and drops what predates it", () => {
    expect(matchesQuery(message(), { since: NOON })).toBe(true);
    expect(matchesQuery(message({ date: "2026-08-13T11:59:00Z" }), { since: NOON })).toBe(false);
  });

  it("rejects an unparseable date when a window was asked for", () => {
    expect(matchesQuery(message({ date: "no idea" }), { since: NOON })).toBe(false);
    expect(matchesQuery(message({ date: "no idea" }), {})).toBe(true);
  });

  it("matches sender and subject case-insensitively, on a substring", () => {
    expect(matchesQuery(message(), { from: "TELEGRAM" })).toBe(true);
    expect(matchesQuery(message(), { subject: "login" })).toBe(true);
    expect(matchesQuery(message(), { from: "discord" })).toBe(false);
    expect(matchesQuery(message(), { subject: "invoice" })).toBe(false);
  });

  it("requires every supplied filter to pass", () => {
    expect(matchesQuery(message(), { from: "telegram", subject: "invoice" })).toBe(false);
  });
});

describe("findCode", () => {
  it("skips messages with no code and returns the first that matches", () => {
    const found = findCode(
      [
        message({ subject: "Newsletter", code: undefined, date: "2026-08-13T12:09:00Z" }),
        message({ subject: "Your login code", code: "112233" }),
      ],
      { since: NOON },
    );
    expect(found?.code).toBe("112233");
  });

  it("ignores a code that predates the window", () => {
    const old = message({ code: "999999", date: "2026-08-13T11:00:00Z" });
    expect(findCode([old], { since: NOON })).toBeUndefined();
    expect(findCode([old], {})?.code).toBe("999999");
  });

  it("returns undefined when the sender filter excludes everything", () => {
    expect(findCode([message()], { from: "discord" })).toBeUndefined();
  });
});
