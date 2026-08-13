import { describe, expect, it } from "vitest";
import { usedAtFrom } from "../services/usage";
import type { MailMessage } from "../types";

const COPIED_AT = Date.parse("2026-08-13T09:00:00Z");

function message(date: string): MailMessage {
  return { send: "no-reply@example.com", subject: "Hi", text: "", html: "", date };
}

describe("usedAtFrom", () => {
  it("returns null when the address was never copied", () => {
    expect(usedAtFrom([message("2026-08-13T10:00:00Z")], null, null)).toBeNull();
  });

  it("takes the arrival time of a message that landed after the copy", () => {
    const at = usedAtFrom([message("2026-08-13T09:30:00Z")], COPIED_AT, null);
    expect(at).toBe(Date.parse("2026-08-13T09:30:00Z"));
  });

  it("ignores mail that predates the copy", () => {
    expect(usedAtFrom([message("2026-08-13T08:59:00Z")], COPIED_AT, null)).toBeNull();
  });

  it("picks the newest of several messages", () => {
    const at = usedAtFrom(
      [message("2026-08-13T09:10:00Z"), message("2026-08-13T11:00:00Z"), message("bad date")],
      COPIED_AT,
      null,
    );
    expect(at).toBe(Date.parse("2026-08-13T11:00:00Z"));
  });

  it("does not move the stamp backwards or rewrite it for mail already counted", () => {
    const recorded = Date.parse("2026-08-13T10:00:00Z");
    expect(usedAtFrom([message("2026-08-13T10:00:00Z")], COPIED_AT, recorded)).toBeNull();
    expect(usedAtFrom([message("2026-08-13T09:30:00Z")], COPIED_AT, recorded)).toBeNull();
  });

  it("advances the stamp when newer mail arrives", () => {
    const recorded = Date.parse("2026-08-13T10:00:00Z");
    const at = usedAtFrom([message("2026-08-13T12:00:00Z")], COPIED_AT, recorded);
    expect(at).toBe(Date.parse("2026-08-13T12:00:00Z"));
  });

  it("returns null for an empty folder and for unparseable dates", () => {
    expect(usedAtFrom([], COPIED_AT, null)).toBeNull();
    expect(usedAtFrom([message("not a date")], COPIED_AT, null)).toBeNull();
  });
});
