import { describe, expect, it } from "vitest";
import { pickForPanel, sortByDate } from "../services/mail";
import type { Mailbox } from "../types";

function message(date: string, mailbox: Mailbox, code?: string) {
  return { send: "a@b.com", subject: "s", text: "", html: "", date, mailbox, code };
}

describe("sortByDate", () => {
  it("puts the newest first regardless of which folder it came from", () => {
    const sorted = sortByDate([
      message("2026-08-13T09:00:00Z", "INBOX"),
      message("2026-08-13T11:00:00Z", "Junk"),
      message("2026-08-13T10:00:00Z", "INBOX"),
    ]);
    expect(sorted.map((m) => m.date)).toEqual([
      "2026-08-13T11:00:00Z",
      "2026-08-13T10:00:00Z",
      "2026-08-13T09:00:00Z",
    ]);
  });

  it("sorts an unparseable date last instead of scrambling the order", () => {
    const sorted = sortByDate([
      message("not a date", "Junk"),
      message("2026-08-13T09:00:00Z", "INBOX"),
      message("2026-08-13T10:00:00Z", "Junk"),
    ]);
    expect(sorted.map((m) => m.date)).toEqual([
      "2026-08-13T10:00:00Z",
      "2026-08-13T09:00:00Z",
      "not a date",
    ]);
  });

  it("leaves the input array alone", () => {
    const input = [
      message("2026-08-13T09:00:00Z", "INBOX"),
      message("2026-08-13T11:00:00Z", "Junk"),
    ];
    sortByDate(input);
    expect(input[0].date).toBe("2026-08-13T09:00:00Z");
  });
});

describe("pickForPanel", () => {
  it("prefers a message with a code over a newer one without", () => {
    const picked = pickForPanel([
      message("2026-08-13T11:00:00Z", "INBOX"),
      message("2026-08-13T10:00:00Z", "Junk", "483920"),
    ]);
    expect(picked?.code).toBe("483920");
    expect(picked?.mailbox).toBe("Junk");
  });

  it("takes the newest when nothing carries a code", () => {
    const picked = pickForPanel([
      message("2026-08-13T11:00:00Z", "Junk"),
      message("2026-08-13T10:00:00Z", "INBOX"),
    ]);
    expect(picked?.date).toBe("2026-08-13T11:00:00Z");
  });

  it("returns null for an empty mailbox pair", () => {
    expect(pickForPanel([])).toBeNull();
  });
});
